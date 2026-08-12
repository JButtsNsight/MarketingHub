import { z } from "zod";

import { AuthError, type AppUser } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  MAX_VALUE_LEN,
  auditVaultAction,
  deleteSecret,
  listSecrets,
  updateSecret,
  type VaultSecretMeta,
} from "@/lib/console/vault";

/**
 * Per-secret vault console route, gated on the platform section.
 * PATCH replaces a secret's name/description/value via `vault.update_secret`
 * (the vault function REPLACES — all three fields are required, and the value
 * is re-encrypted); DELETE removes the row, but only when the body's `confirm`
 * field echoes the secret's name (or its id when the name is null) — the
 * server-side half of the UI's typed-name confirm, exactly like the storage
 * buckets route. A bare `{}` can never delete a secret.
 *
 * Both verbs resolve the secret's CURRENT metadata first (404 when it does
 * not exist) so the confirm check and the audit row use server truth, not
 * whatever the client claims. All responses are `Cache-Control: no-store`
 * and every success writes a best-effort METADATA-ONLY audit row.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Group-gate the request; returns the user (audit actor) or the 401/403. */
async function gate(req: Request): Promise<AppUser | Response> {
  try {
    return await requireSectionApi(req.headers, "platform");
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

/** `[console:vault]` failures → 400 (the data layer sanitizes the message). */
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

function notFound(): Response {
  return Response.json(
    { error: "Secret not found" },
    { status: 404, headers: NO_STORE },
  );
}

// The data layer regex-gates uuids again before any SQL splice; here a
// non-uuid path segment simply cannot name a secret → 404.
const UuidSchema = z.string().uuid();

/** Validate + normalize the path id, or the 404 response. */
async function secretId(context: {
  params: Promise<{ id: string }>;
}): Promise<string | Response> {
  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) return notFound();
  return id.toLowerCase();
}

/** The secret's CURRENT server-side metadata; null when it does not exist. */
async function findSecret(id: string): Promise<VaultSecretMeta | null> {
  const secrets = await listSecrets();
  return secrets.find((s) => s.id === id) ?? null;
}

// All three fields required: vault.update_secret replaces, it does not patch.
const UpdateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESCRIPTION_LEN),
  value: z.string().min(1, "value is required").max(MAX_VALUE_LEN),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await gate(req);
  if (user instanceof Response) return user;

  const id = await secretId(context);
  if (id instanceof Response) return id;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = UpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }

  // vault.update_secret updates zero rows silently for a missing id — check
  // existence up front so a stale edit surfaces as 404, not a fake success.
  if ((await findSecret(id)) === null) return notFound();

  const updated = await vaultAttempt(() => updateSecret(id, parsed.data));
  if (updated instanceof Response) return updated;

  await auditVaultAction({
    secretId: id,
    secretName: parsed.data.name,
    actor: user.email,
    action: "update",
  });

  return Response.json({ updated: true }, { headers: NO_STORE });
}

const DeleteSchema = z.object({
  /**
   * Must echo the secret's name (or its id when the name is null) — the
   * server-enforced half of the typed-name confirm.
   */
  confirm: z.string(),
});

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await gate(req);
  if (user instanceof Response) return user;

  const id = await secretId(context);
  if (id instanceof Response) return id;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = DeleteSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }

  // Compare against SERVER truth — deleting is refused unless the caller
  // typed back what the vault actually stores for this id.
  const meta = await findSecret(id);
  if (meta === null) return notFound();
  const expected = meta.name ?? meta.id;
  if (parsed.data.confirm !== expected) {
    return Response.json(
      { error: "confirm must match the secret name exactly" },
      { status: 400, headers: NO_STORE },
    );
  }

  const deleted = await vaultAttempt(() => deleteSecret(id));
  if (deleted instanceof Response) return deleted;

  await auditVaultAction({
    secretId: id,
    secretName: meta.name,
    actor: user.email,
    action: "delete",
  });

  return Response.json({ deleted: true }, { headers: NO_STORE });
}
