import { Stack, StackProps, Tags, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';

export interface ComputeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly ec2Sg: ec2.ISecurityGroup;
  readonly dataKey: kms.IKey;
  readonly storageBucket: s3.IBucket;
  readonly backupBucket: s3.IBucket;
  readonly appConfigSecret: secretsmanager.ISecret;
  readonly serviceRoleSecret: secretsmanager.ISecret;
  readonly storageCredsSecret: secretsmanager.ISecret;
  readonly smtpSecret: secretsmanager.ISecret;
}

export class ComputeStack extends Stack {
  public readonly instance: ec2.Instance;
  public readonly instanceRole: iam.Role;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // --- Instance role (spec §13, §21): exact-ARN scoped, SSM-only host access ---
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Supabase host role — SSM, scoped secrets, backup bucket, CW Logs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Read exactly the four host secrets — never "*". Expressed as identity-policy
    // statements on the role (referencing the exact secret/key ARNs) rather than
    // `secret.grantRead()`: the latter mutates the Foundation/Data-owned CMK *resource*
    // policy to name this role, which makes Foundation depend on Compute and — with the
    // existing Compute -> Data -> Foundation edges — forms a stack dependency cycle
    // (the exact v1 trap; see DataStack's identical identity-policy workaround, spec §21).
    const hostSecrets: secretsmanager.ISecret[] = [
      props.appConfigSecret,
      props.serviceRoleSecret,
      props.storageCredsSecret,
      props.smtpSecret,
    ];
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadHostSecrets',
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: hostSecrets.map((s) => s.secretArn),
    }));

    // kms:Decrypt on exactly the CMK(s) that encrypt those secrets (dedup by ARN).
    // GetSecretValue decrypts via Secrets Manager, so the role needs Decrypt on the
    // secrets' CMKs — granted here on exact key ARNs, never "*".
    const secretKeyArns = Array.from(
      new Set(
        hostSecrets
          .map((s) => s.encryptionKey?.keyArn)
          .filter((a): a is string => !!a),
      ),
    );
    if (secretKeyArns.length > 0) {
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'DecryptSecretCmks',
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: secretKeyArns,
      }));
    }

    // pgBackRest + nightly pg_dump run as host processes and write the backup bucket.
    // Identity-policy S3 grant on the exact bucket ARN — never a bucket resource policy
    // naming the role (spec §21; avoids the v1 circular dependency).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BackupBucketReadWrite',
      actions: [
        's3:GetObject', 's3:PutObject', 's3:DeleteObject',
        's3:ListBucket', 's3:GetBucketLocation',
        's3:AbortMultipartUpload', 's3:ListMultipartUploadParts',
      ],
      resources: [props.backupBucket.bucketArn, `${props.backupBucket.bucketArn}/*`],
    }));

    // KMS on the backup bucket's CMK (backupKey) so pgBackRest/pg_dump can write
    // SSE-KMS objects — exact key ARN, identity-policy (no resource-policy cycle).
    const backupKeyArn = props.backupBucket.encryptionKey?.keyArn;
    if (backupKeyArn) {
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'BackupBucketKms',
        actions: [
          'kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*',
          'kms:GenerateDataKey*', 'kms:DescribeKey',
        ],
        resources: [backupKeyArn],
      }));
    }

    // NOTE: intentionally NO grant on props.storageBucket — the Storage *container*
    // uses its own bucket-scoped IAM creds from storageCredsSecret (spec §10). The
    // host role must never reach the PHI object store.
    void props.storageBucket;

    // CloudWatch Logs put (agent ships host + container logs; log groups live in
    // ObservabilityStack / are created by the agent).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsPut',
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream',
        'logs:PutLogEvents', 'logs:DescribeLogStreams',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/nsight-supabase/*`],
    }));

    this.instanceRole = role;

    // --- Host-side assets staged onto the instance via user-data (spec §7) ---
    const assetDir = path.join(__dirname, '..', 'assets');

    const userData = ec2.UserData.forLinux();
    // Export the exact ARNs/names the bootstrap requires (fail-loud if unset).
    userData.addCommands(
      'set -euo pipefail',
      'install -d -m 0755 /opt/supabase',
      'install -d -m 0750 /etc/pgbackrest',
      `export APP_CONFIG_SECRET_ARN='${props.appConfigSecret.secretArn}'`,
      `export SERVICE_ROLE_SECRET_ARN='${props.serviceRoleSecret.secretArn}'`,
      `export STORAGE_CREDS_SECRET_ARN='${props.storageCredsSecret.secretArn}'`,
      `export SMTP_SECRET_ARN='${props.smtpSecret.secretArn}'`,
      `export STORAGE_BUCKET='${props.storageBucket.bucketName}'`,
      `export BACKUP_BUCKET='${props.backupBucket.bucketName}'`,
    );
    // Stage the host-side assets OUT-OF-BAND via S3 (aws-s3-assets), then download them
    // on the host. They are NOT inlined into user-data: the five assets total ~16 KB and
    // inlining them (plus wrapper/heredoc overhead) blows past EC2's 16 KB user-data hard
    // limit, which fails the AWS::EC2::Instance create at CloudFormation. Each asset is
    // read from the CDK staging bucket using the instance role (grantRead below).
    const stage = (name: string, dest: string, mode: string) => {
      const asset = new s3assets.Asset(this, `Asset${name.replace(/[^A-Za-z0-9]/g, '')}`, {
        path: path.join(assetDir, name),
      });
      asset.grantRead(role);
      userData.addS3DownloadCommand({
        bucket: asset.bucket,
        bucketKey: asset.s3ObjectKey,
        localFile: dest,
      });
      userData.addCommands(`chmod ${mode} '${dest}'`);
    };
    stage('render-env.sh', '/opt/supabase/render-env.sh', '0750');
    stage('docker-compose.override.yml', '/opt/supabase/docker-compose.override.yml', '0644');
    stage('pgbackrest.conf', '/etc/pgbackrest/pgbackrest.conf', '0640');
    stage('pgbackrest-cron', '/usr/local/bin/pgbackrest-cron', '0750');
    stage('bootstrap.sh', '/opt/supabase/bootstrap.sh', '0700');
    // Substitute the pgbackrest.conf placeholders with the real bucket/region.
    userData.addCommands(
      'sed -i "s|__BACKUP_BUCKET__|${BACKUP_BUCKET}|; s|__AWS_REGION__|us-east-1|" /etc/pgbackrest/pgbackrest.conf',
      '/opt/supabase/bootstrap.sh',
    );

    // --- The Supabase host (spec §7): single m6i.xlarge, AL2023, private subnet ---
    const dataVolumeDeviceName = '/dev/sdf'; // Nitro renames to /dev/nvme1n1 on AL2023

    this.instance = new ec2.Instance(this, 'Host', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.ec2Sg,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      userData,
      // IMDSv2 enforced (HttpTokens: required) with hop-limit 1. Using the individual
      // metadata-option props (not requireImdsv2) because this CDK version forbids
      // combining requireImdsv2 with metadata options.
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,   // blocks container -> IMDS SSRF (spec §7)
      // Propagate instance tags to the attached EBS volumes at create time. CFN block
      // devices cannot carry per-volume tags, so this is the ONLY way the data volume
      // receives supabase:backup=true; without it Phase 2's BackupSelection.fromTag
      // matches zero volumes and the AWS Backup / Vault-Lock tier never protects it.
      propagateTagsToVolumeOnCreation: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda', // AL2023 root device
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: props.dataKey,
            deleteOnTermination: true,
          }),
        },
        {
          deviceName: dataVolumeDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(200, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: props.dataKey,
            deleteOnTermination: false, // Postgres state survives instance replacement
          }),
        },
      ],
    });

    // With propagateTagsToVolumeOnCreation: true (set on the instance above), this
    // instance tag propagates to the attached volumes at create time — the data volume
    // therefore receives supabase:backup=true, which Phase 2's BackupSelection matches.
    Tags.of(this.instance).add('supabase:backup', 'true');
    Tags.of(this.instance).add('Name', 'nsight-supabase-host');

    // --- EC2 auto-recovery (spec §7): recover the SAME instance + same EBS on a
    // failed system status check. This is the single-instance resilience mechanism. ---
    const systemStatusMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'StatusCheckFailed_System',
      dimensionsMap: { InstanceId: this.instance.instanceId },
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });

    const recoveryAlarm = new cloudwatch.Alarm(this, 'SystemStatusRecoveryAlarm', {
      alarmName: 'nsight-supabase-host-system-status-recover',
      alarmDescription: 'Auto-recover the Supabase host on a failed EC2 system status check',
      metric: systemStatusMetric,
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    recoveryAlarm.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));
  }
}
