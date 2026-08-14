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
//   - Base URL is INSTANCE-scoped (shared tenants ride dedi.emailbison.com;
//     dedicated instances get their own host), so it is stored with the key.

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  BISON_STATUS_FILTERS,
  normalizeBaseUrl,
  type BisonCampaign,
  type BisonPage,
  type BisonStatusFilter,
} from "./bison.shared";

export {
  BISON_STATUS_FILTERS,
  normalizeBaseUrl,
  type BisonCampaign,
  type BisonPage,
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

/** GET a Bison API path; JSON on 2xx, BisonApiError otherwise. */
async function bisonGet(
  conn: Pick<BisonConnection, "baseUrl" | "apiKey">,
  path: string,
  params: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const url = new URL(path, conn.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BISON_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        Accept: "application/json",
      },
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
  try {
    return await res.json();
  } catch {
    throw new BisonApiError(res.status, "EmailBison returned non-JSON");
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

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
