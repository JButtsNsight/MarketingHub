# MCP on self-hosted Supabase — what exists at our pin, and the honest recipe

_Wave 7 (2026-08-08). Status: **documented, deliberately OFF**. Wave 7 changes
NO Kong file — this page records the verified ground truth and the enablement
recipe so the decision, if ever taken, is a deliberate staged infrastructure
change, not a console toggle._

## Verdict at the pin (verified, not doc-inferred)

The pinned bundle (`supabase/supabase@v1.26.05`) **does ship MCP**, dead by
default. Verified against the cached pristine pinned kong.yml
(`/tmp/sb-kong.yml`, sha256
`b50d4ac451536cae912d2b613dc5f16268f39c895b668085837f1433b75e3003`) and the
Studio source at the pin:

- **Two Kong entries exist.** Service `mcp-blocker` terminates `/api/mcp`
  with a 403 (`request-termination` plugin), and service `mcp` maps `/mcp` →
  `http://studio:3000/api/mcp` but is **also** request-terminated 403 by
  default. The `mcp` service carries a commented-out `cors` +
  `ip-restriction` block (localhost allow-list) as the official enablement
  path, labelled "danger zone" upstream.
- **Studio implements the endpoint.** At our pin
  (`supabase/studio:2026.04.27-sha-5f60601`,
  `apps/studio/pages/api/mcp/index.ts`), Studio embeds
  `@supabase/mcp-server-supabase` over a stateless
  `StreamableHTTPServerTransport` (JSON, no sessions/SSE). Query params:
  - `features=` — comma list from `docs,database,development,debugging`
  - `read_only=` — default **false**; when true, SQL runs as a read-only
    Postgres user
- **Tools are the self-hosted subset**: pg-meta `executeSql`,
  list/apply migrations, TypeScript type generation, lints, logs, project
  settings. Cloud tools (account, projects, branching) need the cloud
  Management API and can never work here.
- Our vendored `cdk/assets/kong-nsight.yml` (W6) preserves both MCP blocks
  **unchanged** — only the analytics route was uncommented. The MCP routes on
  the live host answer 403 today.

## The honest recipe (NOT applied — recorded only)

Self-hosted MCP = enabling Kong's `/mcp` route in front of Studio's
`/api/mcp`, per the official guide
(<https://supabase.com/docs/guides/self-hosting/enable-mcp>):

1. Edit the Kong declarative config (for us that means
   `cdk/assets/kong-nsight.yml`, the file actually mounted over the kong
   template — never the bundle copy): in the `mcp` service, remove the
   `request-termination` plugin and uncomment the `cors` + `ip-restriction`
   block, keeping the allow-list to loopback + the docker bridge gateway.
2. Recreate the kong container (`docker compose up -d kong` — a restart does
   not re-read the mounted config; expect a seconds-long gateway blip).
3. Access **only over the SSM tunnel** (port-forward to the instance's
   Kong :8000). Never internet-exposed, no public DNS, no ALB route.

Were this ever approved, the change would follow the W6 mechanism exactly: a
`/tmp` staged host script (written, never run by an agent) with pin-drift and
verification gates, plus the mirrored `cdk/assets/kong-nsight.yml` edit for
first-boot parity. **Neither exists — Wave 7 ships documentation only.**

### Security posture (why it stays off)

- Once enabled, the `/mcp` route has **no key-auth and no ACL** — Kong
  `ip-restriction` is the only protection, and there is no OAuth 2.1
  self-hosted. Anything that can reach the host's :8000 from an allowed IP
  gets a natural-language-driven SQL surface running through pg-meta.
- Supabase's own docs warn against pointing MCP at production data
  (prompt-injection / mutation risk) and mandate tunnel/VPN-only access.
- This is a HIPAA-adjacent prod box; the existing console already provides
  audited, gated SQL access. MCP would duplicate that access with weaker
  controls. If enabled at all, `read_only=true` is the only defensible mode.

## What the npx package is NOT

`npx @supabase/mcp-server-supabase` (the README quick-start) targets the
**cloud Management API** — it authenticates with a platform personal access
token and a `--project-ref`. We have no cloud account, no PAT, no project
ref: **that package is not the self-hosted path and cannot work here.** The
self-hosted path is Studio's embedded `/api/mcp` behind Kong, as above.

## `.mcp.json` example (inert until the route is enabled)

A repo-root `.mcp.json.example` mirrors this block. It assumes an SSM tunnel
forwarding local port 54321 to the Supabase host's Kong (:8000); it does
nothing today — the route answers 403 until the recipe above is applied.

```json
{
  "mcpServers": {
    "supabase-selfhosted": {
      "type": "http",
      "url": "http://127.0.0.1:54321/mcp?features=docs,database,development,debugging&read_only=true"
    }
  }
}
```

Notes:

- `read_only=true` on purpose — drop it only with a written reason.
- No auth headers: the route has none to offer (IP allow-list only), which is
  exactly why it must never leave the tunnel.
- Trim `features=` to what a session needs; `docs,database` covers most
  schema-assist work.

## Sources

- `/tmp/sb-kong.yml` (pristine pinned kong.yml, sha verified) — the two MCP
  service blocks and the commented ip-restriction enablement path
- `github.com/supabase/supabase@v1.26.05` — `apps/studio/pages/api/mcp/index.ts`
- <https://supabase.com/docs/guides/self-hosting/enable-mcp>
- <https://github.com/supabase-community/supabase-mcp>
- Catalog entry: [MCP Server](./supabase-feature-catalog.md#mcp-server)
