'use strict';
// Deploy-time signer for Supabase HS256 JWTs (§12/§13).
// Generates JWT_SECRET, signs ANON_KEY + SERVICE_ROLE_KEY, and writes them into
// Secrets Manager. Never logs secret material; the CR response carries none.
const crypto = require('crypto');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager'); // provided by the Lambda Node 22 runtime

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

exports.handler = async (event) => {
  // Only act on Create/Update; Delete is a no-op (secrets are RETAINed).
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'jwt-signer' };
  }

  const { AppConfigSecretArn, ServiceRoleSecretArn } = event.ResourceProperties;
  const sm = new SecretsManagerClient({});

  // Idempotency: if JWT_SECRET already exists in app-config, do not re-mint
  // (re-minting would invalidate every live session — see §13 rotation runbook).
  const existing = await sm.send(new GetSecretValueCommand({ SecretId: AppConfigSecretArn }));
  const appConfig = JSON.parse(existing.SecretString || '{}');

  if (!appConfig.JWT_SECRET) {
    const jwtSecret = crypto.randomBytes(48).toString('base64'); // ~64 chars, HS256 secret
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 24 * 365 * 10; // 10-yr expiry (legacy anon/service_role keys)
    const anonKey = signJwt({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret);
    const serviceRoleKey = signJwt({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret);

    // §13 randoms with exact length rules (merged into app-config alongside JWT fields).
    const rb64 = (n) => crypto.randomBytes(n).toString('base64');
    if (!appConfig.POSTGRES_PASSWORD)   appConfig.POSTGRES_PASSWORD = rb64(24);
    if (!appConfig.SECRET_KEY_BASE)     appConfig.SECRET_KEY_BASE = crypto.randomBytes(64).toString('hex'); // 128 chars >= 64
    if (!appConfig.VAULT_ENC_KEY)       appConfig.VAULT_ENC_KEY = crypto.randomBytes(24).toString('base64').slice(0, 32); // exactly 32
    if (!appConfig.PG_META_CRYPTO_KEY)  appConfig.PG_META_CRYPTO_KEY = rb64(24);
    if (!appConfig.POOLER_TENANT_ID)    appConfig.POOLER_TENANT_ID = crypto.randomUUID();
    if (!appConfig.S3_PROTOCOL_ACCESS_KEY_ID)     appConfig.S3_PROTOCOL_ACCESS_KEY_ID = crypto.randomBytes(10).toString('hex'); // 20 chars
    if (!appConfig.S3_PROTOCOL_ACCESS_KEY_SECRET) appConfig.S3_PROTOCOL_ACCESS_KEY_SECRET = crypto.randomBytes(30).toString('base64').slice(0, 40); // 40 chars
    // (VAULT_ENC_KEY length is asserted below; SECRET_KEY_BASE length is >= 64.)
    if (appConfig.VAULT_ENC_KEY.length !== 32) {
      throw new Error(`VAULT_ENC_KEY must be exactly 32 chars, got ${appConfig.VAULT_ENC_KEY.length}`);
    }
    if (appConfig.SECRET_KEY_BASE.length < 64) {
      throw new Error(`SECRET_KEY_BASE must be >= 64 chars, got ${appConfig.SECRET_KEY_BASE.length}`);
    }

    appConfig.JWT_SECRET = jwtSecret;
    appConfig.ANON_KEY = anonKey;
    await sm.send(new PutSecretValueCommand({
      SecretId: AppConfigSecretArn,
      SecretString: JSON.stringify(appConfig),
    }));

    // Crown jewel goes into its OWN secret (distinct CMK) — never into app-config.
    await sm.send(new PutSecretValueCommand({
      SecretId: ServiceRoleSecretArn,
      SecretString: JSON.stringify({ SERVICE_ROLE_KEY: serviceRoleKey }),
    }));
  }

  return { PhysicalResourceId: 'jwt-signer' }; // no secret material in the CR response
};
