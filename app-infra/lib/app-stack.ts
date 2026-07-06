import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * MarketingHub application front-door stack: ECS Fargate + public ALB gated by
 * `authenticate-cognito` (Google Workspace SAML) + WAFv2 + Route53. Built out
 * task-by-task in Phase 3 (see plan §Phase 3). This is the Task 3.1 scaffold
 * shell; resources are added under TDD in Task 3.2.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Fail loud on any missing pre-deploy context value (mirrors EdgeStack).
    const req = (k: string): string => {
      const v = this.node.tryGetContext(k) as string | undefined;
      if (!v) throw new Error(`AppStack: required context "${k}" is not set (see plan §Phase 3)`);
      return v;
    };

    // Consume the required context up front so a missing value fails at synth.
    req('appHostname');
    req('hostedZoneId');
    req('hostedZoneName');
    req('googleSamlMetadataUrl');
    req('adminGroup');
    req('marketingGroup');
    req('cognitoDomainPrefix');
    req('appImageTag');
  }
}
