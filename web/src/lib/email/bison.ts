import "server-only";

// EmailBison integration client (Email Campaign Center). Server-only: reads
// and WRITES the connection secret at runtime so an admin can paste the API
// token in the UI and be live immediately — no deploy, no restart ("plug and
// play"). Secret material never reaches the browser: status responses carry
// the instance host + workspace name only.
//
// API facts verified against the instance OpenAPI spec (2026-08-14,
// https://dedi.emailbison.com/api/reference.openapi):
//   - Bearer auth: `Authorization: Bearer <api-user token>` — tokens are
//     workspace-scoped, minted in EmailBison under Settings → Developer API.
//   - GET /api/campaigns — Laravel-paginated {data, meta}; each row carries
//     the dashboard stats inline (emails_sent, opened, replied, bounced,
//     unsubscribed, interested, total_leads, status).
//   - POST /api/campaigns — {name, type:"outbound"}; the campaign is born in
//     Draft. /{id}/pause and /{id}/resume are body-less POSTs.
//   - GET /api/replies — Laravel-paginated; rows carry text_body and/or
//     html_body plus folder/interested/read flags.
//   - Leads flow: POST /api/leads/create-or-update/multiple {data:[...]} then
//     POST /api/campaigns/{id}/leads/attach-leads {lead_ids}. On ACTIVE
//     campaigns Bison syncs attached leads on a ~5-minute cycle.
//   - Base URL is INSTANCE-scoped (shared tenants ride dedi.emailbison.com;
//     dedicated instances get their own host), so it is stored with the key.

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  BISON_STATUS_FILTERS,
  REPLY_FOLDERS,
  REPLY_STATUS_FILTERS,
  normalizeBaseUrl,
  type BisonCampaign,
  type BisonPage,
  type BisonReply,
  type BisonReplyFolder,
  type BisonReplyStatusFilter,
  type BisonStatusFilter,
} from "./bison.shared";

export {
  BISON_STATUS_FILTERS,
  REPLY_FOLDERS,
  REPLY_STATUS_FILTERS,
  normalizeBaseUrl,
  type BisonCampaign,
  type BisonPage,
  type BisonReply,
  type BisonReplyFolder,
  type BisonReplyStatusFilter,
  type BisonStatusFilter,
};

/** Hard client-side deadlines (smithy default is 0 = no timeout). */
export const SECRETS_CONNECTION_TIMEOUT_MS = 2_000;
export const SECRETS_REQUEST_TIMEOUT_MS = 5_000;
/** EmailBison HTTP deadline — a dead instance must not hang the page. */
export const BISON_TIMEOUT_MS = 10_000;
/** Connection cache TTL: how stale a rotated/revoked key can look. */
export const CONNECTION_TTL_MS = 60_000;

type SecretsCommand = GetSecretValueCommand | PutSecretValueCommand;

/** Minimal client surface — lets tests inject a fake without touching AWS. */
export interface SecretsInvoker {
  send(command: SecretsCommand): Promise<unknown>;
}

/** The stored connection. `workspaceName` is display-only, captured at connect. */
export interface BisonConnection {
  baseUrl: string;
  apiKey: string;
  workspaceName: string | null;
}

/** EmailBison answered with a non-2xx — carries the upstream status. */
export class BisonApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BisonApiError";
  }
}

let defaultClient: SecretsManagerClient | undefined;
function client(): SecretsInvoker {
  defaultClient ??= new SecretsManagerClient({
    requestHandler: {
      connectionTimeout: SECRETS_CONNECTION_TIMEOUT_MS,
      requestTimeout: SECRETS_REQUEST_TIMEOUT_MS,
    },
  });
  return defaultClient;
}

function secretArn(): string | null {
  const arn = process.env.EMAILBISON_SECRET_ARN;
  return arn && arn.trim() !== "" ? arn : null;
}

let cache: { at: number; conn: BisonConnection | null } | undefined;

/** Test hook / post-write bust. */
export function bustConnectionCache(): void {
  cache = undefined;
}

/**
 * The stored connection, or null when EmailBison has never been connected
 * (env absent, secret blank, or fields empty). SDK failures THROW — callers
 * surface them; an outage must read as an error, not "not connected".
 */
export async function readConnection(
  invoker: SecretsInvoker = client(),
  { fresh = false }: { fresh?: boolean } = {},
): Promise<BisonConnection | null> {
  const arn = secretArn();
  if (!arn) return null;
  if (!fresh && cache && Date.now() - cache.at < CONNECTION_TTL_MS) {
    return cache.conn;
  }
  const out = (await invoker.send(
    new GetSecretValueCommand({ SecretId: arn }),
  )) as { SecretString?: string };
  let conn: BisonConnection | null = null;
  if (out.SecretString) {
    try {
      const parsed: unknown = JSON.parse(out.SecretString);
      const p = parsed as {
        base_url?: unknown;
        api_key?: unknown;
        workspace_name?: unknown;
      };
      const baseUrl = typeof p.base_url === "string" ? p.base_url : "";
      const apiKey = typeof p.api_key === "string" ? p.api_key : "";
      if (baseUrl !== "" && apiKey !== "") {
        conn = {
          baseUrl,
          apiKey,
          workspaceName:
            typeof p.workspace_name === "string" && p.workspace_name !== ""
              ? p.workspace_name
              : null,
        };
      }
    } catch {
      // Unparseable secret = provisioned-but-blank; connect overwrites it.
    }
  }
  cache = { at: Date.now(), conn };
  return conn;
}

/** Persist a connection (or blanks, for disconnect) and bust the cache. */
export async function writeConnection(
  conn: { baseUrl: string; apiKey: string; workspaceName: string | null } | null,
  invoker: SecretsInvoker = client(),
): Promise<void> {
  const arn = secretArn();
  if (!arn) {
    throw new Error(
      "EMAILBISON_SECRET_ARN is not set — the EmailBison secret is not provisioned on this deployment",
    );
  }
  await invoker.send(
    new PutSecretValueCommand({
      SecretId: arn,
      SecretString: JSON.stringify({
        base_url: conn?.baseUrl ?? "",
        api_key: conn?.apiKey ?? "",
        workspace_name: conn?.workspaceName ?? "",
      }),
    }),
  );
  bustConnectionCache();
}

/** True when the deployment carries the secret wiring at all. */
export function isProvisioned(): boolean {
  return secretArn() !== null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Call a Bison API path; JSON on 2xx, BisonApiError otherwise. */
async function bisonRequest(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  path: string,
  {
    method = "GET",
    params = {},
    body,
    fetchImpl = fetch,
    parseBody = true,
  }: {
    method?: "GET" | "POST";
    params?: Record<string, string>;
    body?: unknown;
    fetchImpl?: FetchLike;
    /** pause/resume answer 200 with no contractual body — skip parsing. */
    parseBody?: boolean;
  } = {},
): Promise<unknown> {
  const url = new URL(path, conn.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BISON_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new BisonApiError(
      0,
      err instanceof Error && err.name === "AbortError"
        ? `EmailBison timed out after ${BISON_TIMEOUT_MS}ms`
        : "EmailBison unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new BisonApiError(
      res.status,
      res.status === 401 || res.status === 403
        ? "EmailBison rejected the API token"
        : `EmailBison answered ${res.status}`,
    );
  }
  if (!parseBody) return undefined;
  try {
    return await res.json();
  } catch {
    throw new BisonApiError(res.status, "EmailBison returned non-JSON");
  }
}

/** GET a Bison API path; JSON on 2xx, BisonApiError otherwise. */
async function bisonGet(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  path: string,
  params: Record<string, string> = {},
  fetchImpl?: FetchLike,
): Promise<unknown> {
  return bisonRequest(conn, path, { params, fetchImpl });
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Bison booleans arrive as true/false or 0/1 depending on endpoint. */
const bool = (v: unknown): boolean => v === true || v === 1;

/** GET /api/campaigns — one page of campaigns with inline stats. */
export async function listCampaigns(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  {
    status,
    page = 1,
    fetchImpl,
  }: { status?: BisonStatusFilter; page?: number; fetchImpl?: FetchLike } = {},
): Promise<{ campaigns: BisonCampaign[]; meta: BisonPage }> {
  const params: Record<string, string> = { page: String(page) };
  if (status) params.status = status;
  const body = (await bisonGet(conn, "/api/campaigns", params, fetchImpl)) as {
    data?: unknown;
    meta?: { current_page?: unknown; last_page?: unknown; total?: unknown };
  };
  const rows = Array.isArray(body.data) ? body.data : [];
  const campaigns: BisonCampaign[] = rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: num(r.id),
      uuid: str(r.uuid),
      name: str(r.name) || `Campaign ${num(r.id)}`,
      status: str(r.status) || "Unknown",
      emailsSent: num(r.emails_sent),
      uniqueOpens: num(r.unique_opens),
      uniqueReplies: num(r.unique_replies),
      bounced: num(r.bounced),
      unsubscribed: num(r.unsubscribed),
      interested: num(r.interested),
      totalLeads: num(r.total_leads),
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    };
  });
  return {
    campaigns,
    meta: {
      currentPage: num(body.meta?.current_page) || page,
      lastPage: num(body.meta?.last_page) || page,
      total: num(body.meta?.total) || campaigns.length,
    },
  };
}

/**
 * Prove a pasted connection works by calling the endpoint the dashboard
 * actually uses, then best-effort fetch the workspace name for display
 * (shape not contractual — any failure just yields null).
 */
export async function validateConnection(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  fetchImpl?: FetchLike,
): Promise<{ workspaceName: string | null }> {
  await listCampaigns(conn, { page: 1, fetchImpl });
  try {
    const body = (await bisonGet(
      conn,
      "/api/workspaces/v1.1",
      {},
      fetchImpl,
    )) as { data?: unknown };
    const rows = Array.isArray(body.data)
      ? (body.data as Record<string, unknown>[])
      : [];
    const current =
      rows.find((w) => w.current === true || w.main === true) ?? rows[0];
    const name = current && typeof current.name === "string" ? current.name : null;
    return { workspaceName: name };
  } catch {
    return { workspaceName: null };
  }
}

/** POST /api/campaigns/{id}/pause — body-less; 200 on success. */
export async function pauseCampaign(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  id: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  await bisonRequest(conn, `/api/campaigns/${id}/pause`, {
    method: "POST",
    fetchImpl,
    parseBody: false,
  });
}

/** POST /api/campaigns/{id}/resume — body-less; 200 on success. */
export async function resumeCampaign(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  id: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  await bisonRequest(conn, `/api/campaigns/${id}/resume`, {
    method: "POST",
    fetchImpl,
    parseBody: false,
  });
}

/** POST /api/campaigns — new outbound campaign, born in Draft. */
export async function createCampaign(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  name: string,
  fetchImpl?: FetchLike,
): Promise<{ id: number; name: string; status: string }> {
  const out = (await bisonRequest(conn, "/api/campaigns", {
    method: "POST",
    body: { name, type: "outbound" },
    fetchImpl,
  })) as { data?: unknown };
  // Tolerate both a bare campaign object and the Laravel {data} wrapper.
  const r = (
    typeof out.data === "object" && out.data !== null ? out.data : out
  ) as Record<string, unknown>;
  return {
    id: num(r.id),
    name: str(r.name) || name,
    status: str(r.status) || "Draft",
  };
}

/** Reduce an HTML body to plain text — no tags survive to the client. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&") // decoded last so &amp;lt; can't become a tag
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** GET /api/replies — one page; bodies are plain text (HTML stripped here). */
export async function listReplies(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  {
    folder,
    status,
    page = 1,
    fetchImpl,
  }: {
    folder?: BisonReplyFolder;
    status?: BisonReplyStatusFilter;
    page?: number;
    fetchImpl?: FetchLike;
  } = {},
): Promise<{ replies: BisonReply[]; meta: BisonPage }> {
  const params: Record<string, string> = { page: String(page) };
  if (folder) params.folder = folder;
  if (status) params.status = status;
  const body = (await bisonRequest(conn, "/api/replies", {
    params,
    fetchImpl,
  })) as {
    data?: unknown;
    meta?: { current_page?: unknown; last_page?: unknown; total?: unknown };
  };
  const rows = Array.isArray(body.data) ? body.data : [];
  const replies: BisonReply[] = rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: num(r.id),
      campaignId: num(r.campaign_id),
      fromName: str(r.from_name),
      fromEmail: str(r.from_email_address),
      subject: str(r.subject),
      body: str(r.text_body) || stripHtml(str(r.html_body)),
      dateReceived: typeof r.date_received === "string" ? r.date_received : null,
      folder: str(r.folder),
      interested: bool(r.interested),
      read: bool(r.read),
    };
  });
  return {
    replies,
    meta: {
      currentPage: num(body.meta?.current_page) || page,
      lastPage: num(body.meta?.last_page) || page,
      total: num(body.meta?.total) || replies.length,
    },
  };
}

/** Format gate only — EmailBison does the real validation on its side. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Upstream cap per create-or-update/multiple request. */
export const LEAD_BATCH_SIZE = 100;

/**
 * Upsert leads (sequential batches of LEAD_BATCH_SIZE) then attach every
 * returned id to the campaign in ONE call. On ACTIVE campaigns Bison syncs
 * attached leads on a ~5-minute cycle — user-facing copy must say so.
 */
export async function pushLeads(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  campaignId: number,
  leads: { email: string; firstName?: string; lastName?: string }[],
  fetchImpl?: FetchLike,
): Promise<{ attached: number; skipped: number; message: string }> {
  if (leads.length === 0) {
    throw new Error("pushLeads requires at least one lead");
  }
  const valid = leads.filter((l) => EMAIL_RE.test(l.email.trim()));
  const skipped = leads.length - valid.length;
  if (valid.length === 0) {
    return { attached: 0, skipped, message: "no valid email addresses" };
  }
  // Partial-failure honesty: create-or-update is an idempotent upsert, so a
  // failure AFTER some leads landed must say so and say retrying is safe —
  // an opaque 502 here would hide real state in the EmailBison workspace.
  const partial = (err: unknown, saved: number, stage: string): never => {
    const upstream = err instanceof BisonApiError ? ` (${err.message})` : "";
    const status = err instanceof BisonApiError ? err.status : 0;
    throw new BisonApiError(
      status,
      `${saved} lead${saved === 1 ? "" : "s"} were saved to EmailBison but ${stage} failed${upstream} — retrying the push is safe (saved leads update, never duplicate)`,
    );
  };
  const ids: number[] = [];
  for (let i = 0; i < valid.length; i += LEAD_BATCH_SIZE) {
    const batch = valid.slice(i, i + LEAD_BATCH_SIZE).map((l) => ({
      email: l.email.trim(),
      ...(l.firstName ? { first_name: l.firstName } : {}),
      ...(l.lastName ? { last_name: l.lastName } : {}),
    }));
    let out: { data?: unknown };
    try {
      out = (await bisonRequest(conn, "/api/leads/create-or-update/multiple", {
        method: "POST",
        body: { data: batch },
        fetchImpl,
      })) as { data?: unknown };
    } catch (err) {
      if (ids.length > 0) partial(err, ids.length, "saving the rest");
      throw err;
    }
    const rows = Array.isArray(out.data) ? out.data : [];
    for (const row of rows) {
      const id = (row as Record<string, unknown>).id;
      if (typeof id === "number") ids.push(id);
    }
  }
  if (ids.length === 0) {
    throw new BisonApiError(0, "EmailBison returned no lead ids");
  }
  let attach: { data?: { message?: unknown } };
  try {
    attach = (await bisonRequest(
      conn,
      `/api/campaigns/${campaignId}/leads/attach-leads`,
      { method: "POST", body: { lead_ids: ids }, fetchImpl },
    )) as { data?: { message?: unknown } };
  } catch (err) {
    return partial(err, ids.length, "attaching them to the campaign");
  }
  return {
    attached: ids.length,
    skipped,
    message: str(attach.data?.message) || "leads attached",
  };
}
