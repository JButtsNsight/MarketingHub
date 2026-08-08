import { z } from "zod";

import { AuthError, requireUser, type AppUser } from "@/lib/auth";
import {
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  MAX_VALUE_LEN,
  auditVaultAction,
  createSecret,
  listSecrets,
} from "@/lib/console/vault";

/**
 * Vault console collection route (Studio → Integrations → Vault), gated on the
 * Cognito `marketing` group. GET lists secret METADATA (id/name/description/
 * timestamps — the data layer never selects the ciphertext column, let alone
 * the decrypting view); POST creates a secret via `vault.create_secret`.
 *
 * This surface is MAXIMALLY SENSITIVE, so beyond the usual console-route
 * shape (requireUser, zod inputs, `[console:vault]` → 400):
 *
 *   - Every response carries `Cache-Control: no-store` — nothing on this
 *     surface may land in a browser or proxy cache.
 *   - Each mutation writes a best-effort METADATA-ONLY audit row (secret id,
 *     name, actor, action) via `auditVaultAction` — the value is never passed
 *     to the audit path, which has no column for it anyway.
 *   - `[console:vault]` error messages are sanitized by the data layer (no
 *     SQL, no input echo, no PG detail), so forwarding them to the browser
 *     can never leak a value.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Group-gate the request; returns the user (audit actor) or the 401/403. */
async function gate(req: Request): Promise<AppUser | Response> {
  try {
    return await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE },
      );
    }
    throw err;
  }
}

/**
 * Vault-layer failures are user feedback here — surface as 400. The data
 * layer guarantees these messages never carry a secret value; only the
 * `[console:vault]` marker prefix is stripped. Anything else rethrows.
 */
async function vaultAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:vault]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:vault\] /, "") },
        { status: 400, headers: NO_STORE },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  const user = await gate(req);
  if (user instanceof Response) return user;

  // Metadata only, by construction — the reveal endpoint is the ONLY path
  // that ever touches a decrypted value, and it is a separate POST route.
  const secrets = await vaultAttempt(() => listSecrets());
  if (secrets instanceof Response) return secrets;
  return Response.json({ secrets }, { headers: NO_STORE });
}

// Length caps mirror the data layer's — this is the up-front zod reject; the
// lib re-checks (plus NUL bytes) before anything reaches SQL.
const CreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
  value: z.string().min(1, "value is required").max(MAX_VALUE_LEN),
});

export async function POST(req: Request): Promise<Response> {
  const user = await gate(req);
  if (user instanceof Response) return user;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = CreateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }

  const id = await vaultAttempt(() => createSecret(parsed.data));
  if (id instanceof Response) return id;

  // Metadata-only audit row; best-effort by contract (never throws). The
  // secret value is deliberately NOT in scope here.
  await auditVaultAction({
    secretId: id,
    secretName: parsed.data.name,
    actor: user.email,
    action: "create",
  });

  return Response.json({ id }, { status: 201, headers: NO_STORE });
}
