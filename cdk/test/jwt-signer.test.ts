import * as crypto from 'crypto';

// The signer imports @aws-sdk/client-secrets-manager, which the Node 22 Lambda runtime
// provides but is NOT a dev dependency here — mock it virtually. Commands are tagged so the
// fake client can branch, and PutSecretValue inputs are routed through a per-test handler on
// globalThis (jest.mock factories may only close over `mock*`/global state).
jest.mock(
  '@aws-sdk/client-secrets-manager',
  () => ({
    SecretsManagerClient: class {
      send(cmd: any) {
        return (globalThis as any).__smSend(cmd);
      }
    },
    GetSecretValueCommand: class {
      input: any;
      __type = 'get';
      constructor(input: any) {
        this.input = input;
      }
    },
    PutSecretValueCommand: class {
      input: any;
      __type = 'put';
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, signJwt, b64url } = require('../lambda/jwt-signer/index.js');

// Independently re-derive the HS256 signature and compare — a real verification, not a
// reimplementation of the code under test's control flow.
function verifyHs256(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return expected === s;
}

const decodeSegment = (seg: string) =>
  JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

const isBase64Url = (s: string) => /^[A-Za-z0-9_-]+$/.test(s);

describe('b64url', () => {
  test('produces URL-safe base64 with no padding', () => {
    // std base64 of [0xfb,0xff] is "+/8=" — exercises +, / and padding all at once.
    expect(b64url(Buffer.from([0xfb, 0xff]))).toBe('-_8');
    expect(b64url('hello world')).toBe('aGVsbG8gd29ybGQ');
    expect(isBase64Url(b64url(crypto.randomBytes(40)))).toBe(true);
  });
});

describe('signJwt', () => {
  test('emits a valid HS256 token that verifies against the secret', () => {
    const secret = crypto.randomBytes(48).toString('base64');
    const payload = { role: 'anon', iss: 'supabase', iat: 1, exp: 2 };
    const token = signJwt(payload, secret);

    const [h, p, s] = token.split('.');
    expect([h, p, s].every(isBase64Url)).toBe(true); // base64url, not base64
    expect(decodeSegment(h)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decodeSegment(p)).toEqual(payload);
    expect(verifyHs256(token, secret)).toBe(true);
    expect(verifyHs256(token, secret + 'x')).toBe(false); // wrong secret must fail
  });
});

describe('handler', () => {
  const AppConfigSecretArn = 'arn:aws:secretsmanager:us-east-1:439024109088:secret:app-config-AAA';
  const ServiceRoleSecretArn = 'arn:aws:secretsmanager:us-east-1:439024109088:secret:service-role-BBB';
  let puts: Array<{ id: string; body: any }>;

  const wire = (getString: string) => {
    puts = [];
    (globalThis as any).__smSend = (cmd: any) => {
      if (cmd.__type === 'get') return Promise.resolve({ SecretString: getString });
      if (cmd.__type === 'put') {
        puts.push({ id: cmd.input.SecretId, body: JSON.parse(cmd.input.SecretString) });
        return Promise.resolve({});
      }
      throw new Error('unexpected command');
    };
  };

  const event = (RequestType: string) => ({
    RequestType,
    ResourceProperties: { AppConfigSecretArn, ServiceRoleSecretArn },
  });

  test('Create mints JWT_SECRET, signs verifiable ANON_KEY/SERVICE_ROLE_KEY, and enforces §13 lengths', async () => {
    wire('{"DASHBOARD_USERNAME":"supabase_admin","DASHBOARD_PASSWORD":"seeded"}');
    await handler(event('Create'));

    expect(puts).toHaveLength(2);
    const appCfg = puts.find((x) => x.id === AppConfigSecretArn)!.body;
    const svcRole = puts.find((x) => x.id === ServiceRoleSecretArn)!.body;

    // ANON_KEY verifies against the freshly minted JWT_SECRET (the phase crux).
    expect(verifyHs256(appCfg.ANON_KEY, appCfg.JWT_SECRET)).toBe(true);
    expect(decodeSegment(appCfg.ANON_KEY.split('.')[1]).role).toBe('anon');

    // SERVICE_ROLE_KEY is a valid service_role JWT under the SAME secret...
    expect(verifyHs256(svcRole.SERVICE_ROLE_KEY, appCfg.JWT_SECRET)).toBe(true);
    expect(decodeSegment(svcRole.SERVICE_ROLE_KEY.split('.')[1]).role).toBe('service_role');
    // ...and the crown jewel is NEVER written into app-config (§12/§17).
    expect(appCfg.SERVICE_ROLE_KEY).toBeUndefined();

    // §13 exact length rules.
    expect(appCfg.VAULT_ENC_KEY).toHaveLength(32);
    expect(appCfg.SECRET_KEY_BASE.length).toBeGreaterThanOrEqual(64);
    // Seeded values are preserved (read-merge-write, not clobbered).
    expect(appCfg.DASHBOARD_USERNAME).toBe('supabase_admin');
  });

  test('is idempotent — does not re-mint when JWT_SECRET already exists', async () => {
    wire('{"JWT_SECRET":"already-here","ANON_KEY":"x"}');
    await handler(event('Update'));
    expect(puts).toHaveLength(0);
  });

  test('Delete is a no-op that writes nothing', async () => {
    wire('{}');
    const res = await handler({ ...event('Delete'), PhysicalResourceId: 'jwt-signer' });
    expect(res.PhysicalResourceId).toBe('jwt-signer');
    expect(puts).toHaveLength(0);
  });
});
