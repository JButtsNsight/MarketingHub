import * as fs from 'fs';
import * as path from 'path';
import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';

// ---------------------------------------------------------------------------
// Wave-6 first-boot persistence for the Kong analytics route.
//
// bootstrap.sh fetch_bundle re-clones the pinned bundle on any instance
// replacement and `cp -a` clobbers /opt/supabase/volumes/api/kong.yml back to
// pristine (the .git guard never trips). The persistent enable is therefore:
//   * cdk/assets/kong-nsight.yml — vendored pin kong.yml with ONLY the
//     analytics-v1-api route uncommented (marker: "nsight-w6 analytics route");
//   * staged by compute-stack.ts to the NON-bundle path
//     /opt/supabase/kong-nsight.yml;
//   * mounted over the kong container's template target /home/kong/temp.yml
//     via docker-compose.override.yml (compose merges volumes by target).
// The analytics-v1 catch-all (management API + Logflare UI) must STAY
// commented out, and the enabled route is pinned to /api/endpoints/query/*
// (Logflare serves the endpoint MANAGEMENT resources — create/update/delete,
// same private token — directly under /api/endpoints, so the app-facing
// surface must be the QUERY subpath only).
// ---------------------------------------------------------------------------

const assetsDir = path.join(__dirname, '..', 'assets');
const kongAsset = fs.readFileSync(path.join(assetsDir, 'kong-nsight.yml'), 'utf8');
const override = fs.readFileSync(
  path.join(assetsDir, 'docker-compose.override.yml'),
  'utf8',
);

test('kong-nsight.yml carries the w6 marker and an UNCOMMENTED analytics-v1-api service+route', () => {
  expect(kongAsset).toContain('# nsight-w6 analytics route');
  // Service + route uncommented (exact 2-space/4-space indent, no leading '#').
  expect(kongAsset).toMatch(/^ {2}- name: analytics-v1-api$/m);
  expect(kongAsset).toMatch(/^ {6}- name: analytics-v1-api$/m);
  expect(kongAsset).toMatch(/^ {4}url: http:\/\/analytics:4000\/api\/endpoints\/query$/m);
  expect(kongAsset).toMatch(/^ {10}- \/analytics\/v1\/api\/endpoints\/query\/$/m);
});

test('the route is pinned to the QUERY subpath — the /api/endpoints management surface is NOT routed', () => {
  // A bare /analytics/v1/api/endpoints/ path (the bundle's commented shape)
  // would also proxy Logflare's endpoint MANAGEMENT resources (index/create/
  // update/delete behind the SAME private token). Only the query subpath may
  // ever be uncommented.
  expect(kongAsset).not.toMatch(/^ {10}- \/analytics\/v1\/api\/endpoints\/$/m);
  expect(kongAsset).not.toMatch(/^ {4}url: http:\/\/analytics:4000\/api\/endpoints$/m);
});

test('the analytics-v1 catch-all (management API + Logflare UI) STAYS commented out', () => {
  // Still present but only in commented form.
  expect(kongAsset).toMatch(/^ {2}# - name: analytics-v1$/m);
  expect(kongAsset).not.toMatch(/^ {2}- name: analytics-v1$/m);
  expect(kongAsset).toMatch(/^ {2}#     - name: dashboard-v1-all$/m);
  expect(kongAsset).not.toMatch(/^ {6}- name: dashboard-v1-all$/m);
});

test('kong-nsight.yml is otherwise the untouched pin: key-auth consumers + core routes intact', () => {
  // Spot-check the surrounding config survived vendoring: the key-auth consumers
  // and the load-bearing routes the app depends on every day.
  expect(kongAsset).toMatch(/name: rest-v1/);
  expect(kongAsset).toMatch(/name: auth-v1/);
  expect(kongAsset).toMatch(/name: storage-v1/);
  expect(kongAsset).toMatch(/name: realtime-v1-ws/);
  expect(kongAsset).toMatch(/keyauth_credentials/);
  // Kong's entrypoint shell-evals the file — env placeholders must survive.
  expect(kongAsset).toContain('$SUPABASE_ANON_KEY');
  expect(kongAsset).toContain('$SUPABASE_SERVICE_KEY');
});

test('compose override mounts kong-nsight.yml over the kong template target, marker-guarded', () => {
  expect(override).toContain('# nsight-w6 analytics route');
  expect(override).toMatch(
    /\/opt\/supabase\/kong-nsight\.yml:\/home\/kong\/temp\.yml:ro,z/,
  );
  // The mount must live under the kong service (kong: ... before the next service).
  const kongBlock = override.split(/^ {2}kong:$/m)[1]?.split(/^ {2}\w+:$/m)[0] ?? '';
  expect(kongBlock).toContain('/opt/supabase/kong-nsight.yml:/home/kong/temp.yml:ro,z');
});

// --- synth: user-data stages the asset to the non-bundle path ----------------

const env = { account: '439024109088', region: 'us-east-1' };

// Minimal fixture mirroring compute-stack.test.ts's DataFixture (test files
// can't import from each other).
class DataFixture extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly appConfigSecret: secretsmanager.Secret;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly storageCredsSecret: secretsmanager.Secret;
  public readonly smtpSecret: secretsmanager.Secret;
  constructor(scope: Construct, id: string, secretsKey: kms.IKey, props: StackProps) {
    super(scope, id, props);
    this.storageBucket = new s3.Bucket(this, 'Storage');
    this.backupBucket = new s3.Bucket(this, 'Backup');
    const mk = (i: string) => new secretsmanager.Secret(this, i, { encryptionKey: secretsKey });
    this.appConfigSecret = mk('AppConfig');
    this.serviceRoleSecret = mk('ServiceRole');
    this.storageCredsSecret = mk('StorageCreds');
    this.smtpSecret = mk('Smtp');
  }
}

test('compute-stack user-data downloads kong-nsight.yml to /opt/supabase/kong-nsight.yml (0644)', () => {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  const data = new DataFixture(app, 'Data', foundation.secretsKey, { env });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    vpc: network.vpc,
    ec2Sg: network.ec2Sg,
    dataKey: foundation.dataKey,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
    appConfigSecret: data.appConfigSecret,
    serviceRoleSecret: data.serviceRoleSecret,
    storageCredsSecret: data.storageCredsSecret,
    smtpSecret: data.smtpSecret,
  });
  const json = JSON.stringify(Template.fromStack(compute).toJSON());
  expect(json).toContain('/opt/supabase/kong-nsight.yml');
  expect(json).toContain("chmod 0644 '/opt/supabase/kong-nsight.yml'");
});
