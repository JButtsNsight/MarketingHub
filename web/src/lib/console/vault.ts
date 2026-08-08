import "server-only";

import { runQuery } from "./pgmeta";
import { quoteLiteral } from "./identifiers";

/**
 * supabase_vault data layer — MAXIMALLY SENSITIVE. Every call here runs as
 * `supabase_admin` via pg-meta, which can decrypt every secret. The rules
 * this module enforces (and its tests pin):
 *
 *   - Listings read METADATA COLUMNS from `vault.secrets` ONLY — never the
 *     `secret` (ciphertext) column and never `vault.decrypted_secrets`, whose
 *     mere SELECT decrypts every row.
 *   - `revealSecret` is the single deliberate plaintext path: one id-filtered
 *     row from `vault.decrypted_secrets`, never an unfiltered scan. Callers
 *     own the per-secret confirm; this module owns never widening the query.
 *   - NOTHING here logs, caches, or persists a secret value. The single
 *     console.* call in this file emits a CONSTANT string (a best-effort
 *     audit-insert failure — zero request data), and thrown errors for
 *     create/update/reveal are sanitized to "[console:vault] <op> failed" —
 *     no SQL text, no input values, no Postgres detail (PG messages can echo
 *     literals back).
 *   - The audit trail is FAIL-CLOSED for reveals: `auditVaultActionOrThrow`
 *     backs the reveal route, which refuses to decrypt when the audit row
 *     cannot land. Create/update/delete stay best-effort by design.
 *   - Everything spliced into SQL is either a regex-validated uuid or a
 *     string that passed `textLiteral` (reject \0, length caps, then
 *     quote_literal semantics via the shared `quoteLiteral`). `runQuery` has
 *     no bind parameters, so this is the entire injection surface.
 *   - Audit rows are metadata only (id/name/actor/action) — by schema,
 *     `marketinghub.vault_console_audit` has no value column, ever.
 */

function fail(op: string): never {
  // Deliberately detail-free: create/update/reveal inputs include the secret
  // value, and Postgres errors can echo statement literals. Nothing beyond
  // the operation name may escape.
  throw new Error(`[console:vault] ${op} failed`);
}

/** Validation failures carry a description of the RULE, never the input. */
function reject(op: string, rule: string): never {
  throw new Error(`[console:vault] ${op} failed: ${rule}`);
}

/** Defensive caps — vault columns are unbounded text; the console is not. */
export const MAX_NAME_LEN = 256;
export const MAX_DESCRIPTION_LEN = 2000;
export const MAX_VALUE_LEN = 8000;
const MAX_ACTOR_LEN = 256;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Regex-gate a uuid before it is spliced (as `'<id>'::uuid`). */
function assertUuid(op: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    reject(op, "secret id must be a uuid");
  }
  return value.toLowerCase();
}

/**
 * THE text-to-SQL gate for this module: type/NUL/length checks, then the
 * shared quote_literal ('-doubling, E'' backslash form). Every string that
 * reaches vault SQL goes through here — no other path exists.
 */
function textLiteral(
  op: string,
  value: unknown,
  label: string,
  maxLen: number,
): string {
  if (typeof value !== "string") {
    reject(op, `${label} must be a string`);
  }
  if (value.includes("\u0000")) {
    reject(op, `${label} must not contain NUL bytes`);
  }
  if (value.length > maxLen) {
    reject(op, `${label} must be at most ${maxLen} characters`);
  }
  return quoteLiteral(value);
}

/** Metadata-only view of a secret — the plaintext NEVER rides this shape. */
export interface VaultSecretMeta {
  id: string;
  /** vault.secrets.name is nullable (unique only where set). */
  name: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type VaultAuditAction = "create" | "update" | "delete" | "reveal";
const AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
  "reveal",
]);

/**
 * All secrets, metadata columns only, newest first. Reads `vault.secrets`
 * directly — never the `secret` column, never the decrypting view.
 */
export async function listSecrets(): Promise<VaultSecretMeta[]> {
  const rows = await runQuery(
    `select id::text as id,
            name,
            description,
            created_at::text as created_at,
            updated_at::text as updated_at
       from vault.secrets
      order by created_at desc, id`,
  );
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    name: (r.name as string | null) ?? null,
    description: String(r.description ?? ""),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  }));
}

/**
 * Create a secret via `vault.create_secret` (SECURITY DEFINER — it encrypts;
 * the plaintext exists only inside the statement). Returns the new id.
 */
export async function createSecret(opts: {
  name: string;
  description?: string;
  value: string;
}): Promise<string> {
  const op = "create";
  if (typeof opts.name !== "string" || opts.name.length === 0) {
    reject(op, "name is required");
  }
  const name = textLiteral(op, opts.name, "name", MAX_NAME_LEN);
  const description = textLiteral(
    op,
    opts.description ?? "",
    "description",
    MAX_DESCRIPTION_LEN,
  );
  if (typeof opts.value !== "string" || opts.value.length === 0) {
    reject(op, "value is required");
  }
  const value = textLiteral(op, opts.value, "value", MAX_VALUE_LEN);

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await runQuery(
      `select vault.create_secret(${value}, ${name}, ${description})::text as id`,
    );
  } catch {
    fail(op);
  }
  const id = rows[0]?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) fail(op);
  return id;
}

/**
 * Replace a secret's value/name/description via `vault.update_secret`
 * (re-encrypts). All three fields are required — the vault function replaces,
 * it does not patch. key_id is the legacy pgsodium column: always null.
 */
export async function updateSecret(
  id: string,
  opts: { name: string; description: string; value: string },
): Promise<void> {
  const op = "update";
  const uuid = assertUuid(op, id);
  if (typeof opts.name !== "string" || opts.name.length === 0) {
    reject(op, "name is required");
  }
  const name = textLiteral(op, opts.name, "name", MAX_NAME_LEN);
  const description = textLiteral(
    op,
    opts.description,
    "description",
    MAX_DESCRIPTION_LEN,
  );
  if (typeof opts.value !== "string" || opts.value.length === 0) {
    reject(op, "value is required");
  }
  const value = textLiteral(op, opts.value, "value", MAX_VALUE_LEN);

  try {
    await runQuery(
      `select vault.update_secret('${uuid}'::uuid, ${value}, ${name}, ${description}, null)`,
    );
  } catch {
    fail(op);
  }
}

/** Delete a secret row by validated id. Missing rows delete zero, silently. */
export async function deleteSecret(id: string): Promise<void> {
  const uuid = assertUuid("delete", id);
  await runQuery(`delete from vault.secrets where id = '${uuid}'::uuid`);
}

/**
 * THE deliberate plaintext read: exactly one id-filtered row from
 * `vault.decrypted_secrets`. Never call this to build a list; the caller has
 * already shown a per-secret confirm, has already landed the FAIL-CLOSED
 * audit row (`auditVaultActionOrThrow`), and serves the response with
 * no-store.
 */
export async function revealSecret(id: string): Promise<string> {
  const op = "reveal";
  const uuid = assertUuid(op, id);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await runQuery(
      `select decrypted_secret
         from vault.decrypted_secrets
        where id = '${uuid}'::uuid`,
    );
  } catch {
    fail(op);
  }
  const value = rows[0]?.decrypted_secret;
  if (typeof value !== "string") fail(op);
  return value;
}

interface VaultAuditOpts {
  secretId: string | null;
  secretName: string | null;
  actor: string;
  action: VaultAuditAction;
}

/**
 * Build the metadata-only audit INSERT, or null when the inputs cannot form
 * a valid row (empty actor / unknown action). A malformed id becomes null
 * rather than rejecting — the row identifies WHAT was touched as best it
 * can, and `secret_id`/`secret_name` are nullable by schema for exactly this
 * kind of degradation (plus deletes of unnamed secrets).
 */
function auditInsertSql(opts: VaultAuditOpts): string | null {
  if (typeof opts.actor !== "string" || opts.actor.length === 0) return null;
  if (!AUDIT_ACTIONS.has(opts.action)) return null;
  const secretId =
    typeof opts.secretId === "string" && UUID_RE.test(opts.secretId)
      ? `'${opts.secretId.toLowerCase()}'::uuid`
      : "null";
  const secretName =
    typeof opts.secretName === "string"
      ? quoteLiteral(
          opts.secretName.replace(/\u0000/g, "").slice(0, MAX_NAME_LEN),
        )
      : "null";
  const actor = quoteLiteral(
    opts.actor.replace(/\u0000/g, "").slice(0, MAX_ACTOR_LEN),
  );
  return `insert into marketinghub.vault_console_audit (secret_id, secret_name, actor, action)
       values (${secretId}, ${secretName}, ${actor}, '${opts.action}')`;
}

/**
 * Best-effort metadata-only audit row in `marketinghub.vault_console_audit`
 * — for create/update/delete, where blocking the operation on an audit
 * hiccup would be worse than a missed row. NEVER throws, but a failed insert
 * is no longer invisible: it logs ONE constant string (no error detail — PG
 * messages can echo statement literals; no request data of any kind), so a
 * permanently broken audit table surfaces in the app logs instead of every
 * row being silently swallowed forever.
 *
 * Reveals must NOT use this path — they ride `auditVaultActionOrThrow`.
 */
export async function auditVaultAction(opts: VaultAuditOpts): Promise<void> {
  const sql = auditInsertSql(opts);
  if (sql === null) return;
  try {
    await runQuery(sql);
  } catch {
    // Best-effort by contract — the operation already happened. The message
    // below is a CONSTANT: never interpolate the error (or anything else).
    console.error(
      "[console:vault] audit insert failed — a metadata audit row was NOT recorded (best-effort path)",
    );
  }
}

/**
 * FAIL-CLOSED metadata-only audit row — the reveal path's variant. The vault
 * contract is "reveal = explicit per-secret confirm + audited"; that promise
 * is only true if the audit row is a PRECONDITION of the decrypt, so this
 * throws a sanitized `[console:vault]` error whenever the row cannot land
 * (audit table missing in the pre-migration deploy window, pg-meta hiccup,
 * table dropped/renamed later) and the caller must refuse the operation.
 * No Postgres detail ever escapes — the failure message is fixed text.
 */
export async function auditVaultActionOrThrow(
  opts: VaultAuditOpts,
): Promise<void> {
  const op = opts.action;
  const sql = auditInsertSql(opts);
  if (sql === null) {
    reject(op, "audit row rejected — missing actor or unknown action");
  }
  try {
    await runQuery(sql);
  } catch {
    reject(op, `the audit log is unavailable — refusing an unaudited ${op}`);
  }
}
