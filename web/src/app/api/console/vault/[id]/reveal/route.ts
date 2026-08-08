import { z } from "zod";

import { AuthError, requireUser, type AppUser } from "@/lib/auth";
import {
  auditVaultActionOrThrow,
  listSecrets,
  revealSecret,
  type VaultSecretMeta,
} from "@/lib/console/vault";

/**
 * THE deliberate plaintext endpoint — the only place a decrypted vault value
 * ever crosses to the browser. Deliberately POST-only (no other verb is
 * exported): a reveal is a state-changing act (it decrypts and it writes an
 * audit row), it must never be link-followable or prefetchable, and the id
 * travels in the path — never a value, never in a query string.
 *
 * Flow: group gate → id validation → metadata lookup (404 before any decrypt
 * for a secret that does not exist) → FAIL-CLOSED METADATA-ONLY audit row
 * (actor + secret id/name — the value does not exist yet, so it can never
 * reach the audit path) → single id-filtered decrypt via the data layer →
 * JSON `{ value }` under `Cache-Control: no-store`.
 *
 * The audit row lands BEFORE the decrypt, and a failed insert refuses the
 * reveal — the UI's "the reveal is recorded in the vault audit log" claim is
 * a guarantee, not an aspiration (unauditable ⇒ no plaintext; this includes
 * the pre-migration window where marketinghub.vault_console_audit does not
 * exist yet). Consequence: a decrypt that fails AFTER the insert leaves an
 * audit row for a reveal that returned nothing — over-recording is the
 * fail-safe direction, and it means failed reveal attempts are audited too.
 * Nothing here logs, and failure messages come from the data layer
 * pre-sanitized ("[console:vault] reveal failed…").
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

const UuidSchema = z.string().uuid();

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await gate(req);
  if (user instanceof Response) return user;

  const { id: rawId } = await context.params;
  if (!UuidSchema.safeParse(rawId).success) {
    return Response.json(
      { error: "Secret not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const id = rawId.toLowerCase();

  // Metadata lookup first: a missing secret is a clean 404 (never a decrypt
  // attempt), and the audit row records the server-side name, not a claim.
  const secrets = await listSecrets();
  const meta: VaultSecretMeta | undefined = secrets.find((s) => s.id === id);
  if (meta === undefined) {
    return Response.json(
      { error: "Secret not found" },
      { status: 404, headers: NO_STORE },
    );
  }

  // FAIL-CLOSED audit BEFORE the decrypt: no audit row, no plaintext. The
  // row is metadata ONLY — the value does not exist yet at this point, and
  // the audit table has no column that could hold it anyway.
  let value: string;
  try {
    await auditVaultActionOrThrow({
      secretId: meta.id,
      secretName: meta.name,
      actor: user.email,
      action: "reveal",
    });
    value = await revealSecret(id);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:vault]")) {
      // Pre-sanitized by the data layer — carries no SQL, input, or PG detail.
      return Response.json(
        { error: err.message.replace(/^\[console:vault\] /, "") },
        { status: 400, headers: NO_STORE },
      );
    }
    throw err;
  }

  return Response.json({ value }, { headers: NO_STORE });
}
