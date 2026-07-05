import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';

const env = { account: '439024109088', region: 'us-east-1' };

test('creates four rotation-enabled CMKs with retain policy', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::KMS::Key', 4);
  t.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  t.allResources('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
});

test('creates an alias per key', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::KMS::Alias', 4);
});

test('logs key policy grants the CloudWatch Logs service principal', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::KMS::Key', {
    KeyPolicy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'logs.us-east-1.amazonaws.com' },
          Action: Match.arrayWith(['kms:Encrypt*', 'kms:Decrypt*']),
        }),
      ]),
    }),
  });
});
