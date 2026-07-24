import "server-only";

/**
 * Connection facts for the Settings page. Deliberately returns NO secret
 * values — only whether a secret is configured, plus the (non-secret) data-API
 * host and region. The service-role key is never read into a rendered value.
 */
export interface ConnectionInfo {
  supabaseUrlHost: string | null;
  serviceRoleKeySet: boolean;
  albArnSet: boolean;
  region: string;
  cognitoLogoutSet: boolean;
  previewAuth: boolean;
}

export function getConnectionInfo(): ConnectionInfo {
  let host: string | null = null;
  const url = process.env.SUPABASE_URL;
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      host = "(unparseable)";
    }
  }
  return {
    supabaseUrlHost: host,
    serviceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    albArnSet: Boolean(process.env.ALB_ARN),
    region: process.env.ALB_REGION || process.env.AWS_REGION || "us-east-1",
    cognitoLogoutSet: Boolean(process.env.COGNITO_LOGOUT_URL),
    previewAuth: Boolean(process.env.PREVIEW_AUTH),
  };
}
