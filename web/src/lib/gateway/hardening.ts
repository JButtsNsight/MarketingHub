import "server-only";

// Shared headless-claude gateway client + prompt-hardening primitives,
// extracted verbatim from lib/intel/gateway.ts (Wave 8R) so every gateway
// consumer (intel search synthesis, the console SQL assistant) runs the SAME
// audited code paths. Server-only — the api key must never reach a client
// bundle, a log line, or an error body.
//
// The gateway is async two-phase: POST /task enqueues (200 = enqueued only),
// GET /task/{id} reads back exactly two states — `pending` or `completed`.
// There is NO failed/running state: crashed workers and dropped tasks read
// `pending` forever, so the CALLER owns the deadline (each feature exposes
// its own *_POLL_DEADLINE_MS to the browser).

/** Resolved gateway connection settings (from task-def env at runtime). */
export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_MODEL = "claude-opus-4-8";

/** Timeout for a single gateway HTTP round trip (enqueue/poll, not the task). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Read gateway config from env. Both `HEADLESS_CLAUDE_URL` and
 * `HEADLESS_CLAUDE_API_KEY` are required; missing or blank ⇒ null, which
 * callers map to an honest one-line degraded state — never throws.
 */
export function gatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig | null {
  const url = env.HEADLESS_CLAUDE_URL?.trim() ?? "";
  const apiKey = env.HEADLESS_CLAUDE_API_KEY?.trim() ?? "";
  if (!url || !apiKey) return null;
  const model = env.HEADLESS_CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
  return { baseUrl: url.replace(/\/+$/, ""), apiKey, model };
}

/**
 * Fresh namespaced task id per submission (`<namespace>-<uuid>`). The gateway
 * is at-least-once with no idempotency, so ids are never reused; each feature
 * owns a distinct namespace + anchored regex so its poll relay rejects
 * foreign task ids — the shared ClaudeCloud key must never become an oracle
 * for other clients' task results.
 */
export function newTaskId(namespace: string): string {
  return `${namespace}-${crypto.randomUUID()}`;
}

/**
 * Gateway failure. The message must stay generic: never the api key, never
 * the full URL, never response bodies (routes echo these to browsers).
 */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Strip C0/C1 control characters (keeping `\n` and `\t`). Two reasons:
 * control bytes carry no meaning as data, and each one JSON-escapes to 6
 * bytes (`\u0001`) — untrusted text stuffed with them could blow the
 * serialized request past the gateway's 256KB body limit while sailing under
 * the char cap. `\r` is stripped too (CRLF pastes collapse to LF).
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/**
 * Neutralize the prompt's frame grammar inside untrusted text: collapse any
 * run of 3+ angle brackets to 2 so literal `<<<... START/END>>>` delimiters
 * can only ever be produced by US. Without this, untrusted content carrying
 * its own close/open delimiter pair would break out of the untrusted-data
 * containment and speak in the trusted framing channel — forging content AND
 * provenance.
 */
export function neutralizeFrameMarkers(text: string): string {
  return text.replace(/<{3,}|>{3,}/g, (run) => run.slice(0, 2));
}

/**
 * Header fields (e.g. document title / source name) additionally collapse
 * newlines and `|` to spaces: they are attacker-influenced and live OUTSIDE
 * the frame delimiters, so a newline-bearing field could open a forged
 * header line in the trusted channel.
 */
export function sanitizeHeaderField(text: string): string {
  return neutralizeFrameMarkers(
    stripControlChars(text).replace(/[\n|]+/g, " "),
  ).trim();
}

/**
 * One bounded gateway round trip. The abort timer stays armed through BODY
 * consumption, not just headers: a gateway/proxy that returns 200 headers
 * then stalls mid-body must fail at FETCH_TIMEOUT_MS, not hang the relaying
 * route for undici's ~5-minute default body timeout. `expectJson` callers
 * get the parsed body; others never read it (status is all they use).
 */
async function gatewayFetch(
  cfg: GatewayConfig,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  label: string,
  expectJson: boolean,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { "x-api-key": cfg.apiKey, ...init.headers },
      signal: controller.signal,
    });
    if (!res.ok || !expectJson) {
      return { ok: res.ok, status: res.status, body: undefined };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // Distinguish contract breakage (non-JSON 200) from an aborted/stalled
      // body read (rethrown into the generic catch below).
      if (controller.signal.aborted) throw err;
      throw new GatewayError(`gateway ${label} returned a non-JSON body`);
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    // Network failure / timeout. Never surface the underlying error — its
    // message can embed the full request URL.
    throw new GatewayError(`gateway ${label} request failed`);
  } finally {
    clearTimeout(timer);
  }
}

/** One task submission: the caller-built prompt pair plus its envelope. */
export interface GatewaySubmission {
  /** Caller-generated namespaced id (see newTaskId) — never reused. */
  taskId: string;
  prompt: string;
  system: string;
  /** Sent as both `task_type` and the fall-through `system_prompt` name. */
  taskType: string;
  maxTokens: number;
}

/**
 * Enqueue one task (200 from the gateway means enqueued only — poll for the
 * result). Throws GatewayError (generic message) on any failure.
 */
export async function submitTask(
  cfg: GatewayConfig,
  task: GatewaySubmission,
): Promise<void> {
  const res = await gatewayFetch(
    cfg,
    "/task",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_id: task.taskId,
        prompt: task.prompt,
        // Gateway quirk: `system_prompt_text` (inline) is used ONLY when the
        // `prompts/<system_prompt>.md` file is missing from the worker image,
        // and `system_prompt` defaults to "default" whose file EXISTS — so we
        // send a deliberately nonexistent name (the task type) to fall
        // through to our inline prompt. If ClaudeCloud ever ships that file,
        // the server-side file wins (accepted trade-off).
        system_prompt: task.taskType,
        system_prompt_text: task.system,
        model: cfg.model,
        max_tokens: task.maxTokens,
        task_type: task.taskType,
      }),
    },
    "submit",
    // 200 means "enqueued" and the body carries nothing we use — skip it.
    false,
  );
  if (!res.ok) {
    throw new GatewayError(`gateway submit failed (HTTP ${res.status})`);
  }
}

/** Poll outcome: pending, or completed with the RAW `result.output` value. */
export type GatewayTaskState =
  | { state: "pending" }
  | { state: "completed"; output: unknown };

/**
 * Poll one task. `pending` stays pending (the gateway never reports failure
 * — the caller owns the deadline); `completed` hands back the raw
 * `result.output` for the caller to parse against ITS output contract.
 * Gateway/contract breakage (non-2xx, non-JSON body, unknown status) ⇒
 * GatewayError.
 */
export async function pollTask(
  cfg: GatewayConfig,
  taskId: string,
): Promise<GatewayTaskState> {
  const res = await gatewayFetch(
    cfg,
    `/task/${taskId}`,
    { method: "GET" },
    "poll",
    // Body is parsed INSIDE gatewayFetch so the abort timer bounds it too.
    true,
  );
  if (!res.ok) {
    throw new GatewayError(`gateway poll failed (HTTP ${res.status})`);
  }
  const body = res.body;
  const status =
    typeof body === "object" && body !== null
      ? (body as { status?: unknown }).status
      : undefined;
  if (status === "pending") return { state: "pending" };
  if (status !== "completed") {
    throw new GatewayError("gateway poll returned an unknown status");
  }
  const output = (body as { result?: { output?: unknown } }).result?.output;
  return { state: "completed", output };
}

/**
 * Extract the first balanced `{...}` JSON object from model output that may
 * be fenced or wrapped in prose. Returns null when none parses.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
