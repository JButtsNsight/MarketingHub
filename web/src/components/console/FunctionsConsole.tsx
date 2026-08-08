"use client";

import { useState } from "react";

import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { Surface } from "../Surface";

/**
 * Edge Functions console (Studio parity, Wave 5).
 *
 * Three panels over the `marketinghub.edge_functions` registry:
 * - Registry list: name / version / updated / deployed. The registry — not the
 *   host filesystem — is the source of truth (app containers cannot read the
 *   edge-runtime volume), so "deployed" honestly reflects what the staged host
 *   script last shipped.
 * - Source viewer: read-only, straight from the registry row's `source`
 *   column. No fetch — the page preloaded everything.
 * - Invoke tester: JSON body with parse validation, sent through the
 *   server-side proxy at /api/console/functions/invoke (the browser can never
 *   reach Kong). Result panel shows status / duration / content type / body,
 *   with honest error states — including "edge runtime down", the KNOWN
 *   restart-loop until the staged fix script is applied.
 * - Logs: Wave-6 placeholder. Function logs are container stdout today.
 */

export interface EdgeFunctionRow {
  name: string;
  version: string;
  /** ISO timestamp of the last registry write. */
  updated_at: string;
  /** ISO timestamp of the last host deploy; null until the script runs. */
  deployed_at: string | null;
  notes: string | null;
  source: string;
}

export interface InvokeResult {
  status: number;
  durationMs: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/** Fixed UTC format — locale-independent, timestamp-honest. */
function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function FunctionsConsole({
  initialFunctions,
}: {
  initialFunctions: EdgeFunctionRow[];
}) {
  const functions = initialFunctions;

  // Source viewer: which function's registry source is open.
  const [openName, setOpenName] = useState<string | null>(null);

  // Invoke tester state.
  const [target, setTarget] = useState<string>(functions[0]?.name ?? "");
  const [method, setMethod] = useState<"GET" | "POST">("POST");
  const [bodyText, setBodyText] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  const onBodyChange = (value: string) => {
    setBodyText(value);
    if (method === "GET" || value.trim() === "") {
      setParseError(null);
      return;
    }
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (err) {
      setParseError(
        `Body is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const send = async () => {
    if (!target || invoking) return;
    // Parse validation is the gate: never ship an unparseable body upstream.
    if (method === "POST" && bodyText.trim() !== "") {
      try {
        JSON.parse(bodyText);
      } catch (err) {
        setParseError(
          `Body is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    setParseError(null);
    setInvoking(true);
    setResult(null);
    setInvokeError(null);
    try {
      const res = await fetch("/api/console/functions/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: target,
          method,
          ...(method === "POST" && bodyText.trim() !== ""
            ? { body: bodyText }
            : {}),
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | (Partial<InvokeResult> & { error?: string; reason?: string })
        | null;
      if (res.ok && payload && typeof payload.status === "number") {
        setResult({
          status: payload.status,
          durationMs: payload.durationMs ?? 0,
          contentType: payload.contentType ?? null,
          body: payload.body ?? "",
          truncated: payload.truncated === true,
        });
        return;
      }
      // Honest error states, mapped from the proxy's contract.
      if (res.status === 502) {
        setInvokeError(
          `Edge runtime down — the request never got a response. ${payload?.reason ?? ""} ` +
            "The edge-functions container is a known restart-loop until the staged fix script is applied.",
        );
      } else if (res.status === 503) {
        setInvokeError(
          `Invoke unavailable — ${payload?.reason ?? "the server is missing edge-function configuration."}`,
        );
      } else if (res.status === 404) {
        setInvokeError(
          payload?.error ?? "That function is not in the registry.",
        );
      } else {
        setInvokeError(payload?.error ?? `Invoke failed (HTTP ${res.status}).`);
      }
    } catch {
      setInvokeError("Network error — please try again.");
    } finally {
      setInvoking(false);
    }
  };

  const columns: Column<EdgeFunctionRow>[] = [
    { key: "name", header: "function", mono: true },
    {
      key: "version",
      header: "version",
      width: "110px",
      render: (f) => <Badge tone="var(--data-2)">v{f.version}</Badge>,
    },
    {
      key: "updated_at",
      header: "updated",
      mono: true,
      width: "170px",
      render: (f) => fmtTs(f.updated_at),
    },
    {
      key: "deployed_at",
      header: "deployed",
      mono: true,
      width: "170px",
      render: (f) =>
        f.deployed_at ? (
          fmtTs(f.deployed_at)
        ) : (
          <Badge tone="var(--warn)">not deployed</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      width: "200px",
      align: "right",
      render: (f) => (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className={openName === f.name ? "type-chip on" : "type-chip"}
            onClick={() => setOpenName(openName === f.name ? null : f.name)}
          >
            {openName === f.name ? "Hide source" : "Source"}
          </button>
          <button
            type="button"
            className={target === f.name ? "type-chip on" : "type-chip"}
            onClick={() => setTarget(f.name)}
          >
            Invoke
          </button>
        </div>
      ),
    },
  ];

  const openFn = functions.find((f) => f.name === openName) ?? null;
  const statusTone = (status: number) =>
    status >= 200 && status < 300 ? "var(--data-2)" : "var(--warn)";

  return (
    <div className="stack">
      <Section
        eyebrow="Registry"
        title="Edge Functions"
        description="Deployed Deno functions, served by the edge-runtime container behind Kong. The marketinghub.edge_functions registry is the source of truth — the app cannot read the runtime's volume."
      >
        <DataTable
          columns={columns}
          rows={functions}
          getRowKey={(f) => f.name}
          empty="No edge functions registered yet — the Wave-5 migration and the staged host fix script (seeding main / hello / embed) have not been applied."
        />
      </Section>

      {openFn ? (
        <Surface className="teditor-insert" elevated={false}>
          <div className="dgrid-toolbar" style={{ border: "none", padding: 0 }}>
            <span className="eyebrow">Source · {openFn.name}/index.ts</span>
            <span className="spacer" />
            <button
              type="button"
              className="type-chip"
              onClick={() => setOpenName(null)}
            >
              Close
            </button>
          </div>
          <p className="teditor-test">
            Read-only, from the registry row (version {openFn.version}
            {openFn.notes ? ` — ${openFn.notes}` : ""}). Edits ship via the
            staged host script, never from here.
          </p>
          <CodeBlock code={openFn.source} label="typescript" />
        </Surface>
      ) : null}

      <Section
        eyebrow="Invoke"
        title="Invoke tester"
        description="Runs the function server-side through Kong (/functions/v1/<name>) — 20s timeout, 64KB response cap. Your browser session headers are never forwarded."
      >
        <div className="stack">
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="eyebrow">Function</span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={functions.length === 0}
              >
                {functions.length === 0 ? (
                  <option value="">No functions registered</option>
                ) : (
                  functions.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="eyebrow">Method</span>
              <select
                value={method}
                onChange={(e) => {
                  const next = e.target.value === "GET" ? "GET" : "POST";
                  setMethod(next);
                  if (next === "GET") setParseError(null);
                }}
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
            </label>
            <button
              type="button"
              className="type-chip"
              onClick={send}
              disabled={
                invoking ||
                !target ||
                (method === "POST" && parseError !== null)
              }
            >
              {invoking ? "Invoking…" : "Send request"}
            </button>
          </div>

          {method === "POST" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span className="eyebrow">JSON body</span>
              <textarea
                className="mono"
                rows={6}
                value={bodyText}
                onChange={(e) => onBodyChange(e.target.value)}
                spellCheck={false}
              />
            </label>
          ) : null}

          {parseError ? (
            <p className="form-error" role="alert">
              {parseError}
            </p>
          ) : null}
          {invokeError ? (
            <p className="form-error" role="alert">
              {invokeError}
            </p>
          ) : null}

          {result ? (
            <div className="stack">
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Badge tone={statusTone(result.status)}>
                  HTTP {result.status}
                </Badge>
                <span className="mono">{result.durationMs}ms</span>
                {result.contentType ? (
                  <Badge>{result.contentType}</Badge>
                ) : null}
                {result.truncated ? (
                  <Badge tone="var(--warn)" title="Response exceeded the 64KB cap">
                    truncated at 64KB
                  </Badge>
                ) : null}
              </div>
              <CodeBlock
                code={result.body === "" ? "(empty body)" : result.body}
                label="response body"
              />
            </div>
          ) : null}
        </div>
      </Section>

      <Section eyebrow="Logs" title="Logs">
        {/* Wave-6 placeholder — no fake data, no dead controls. */}
        <p className="teditor-test">
          Logs are edge-runtime container stdout; surfacing lands with Logflare
          (Wave 6).
        </p>
      </Section>
    </div>
  );
}

export default FunctionsConsole;
