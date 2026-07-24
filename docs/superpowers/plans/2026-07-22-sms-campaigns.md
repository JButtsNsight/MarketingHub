# SMS Campaigns — Monday.com patient lists → SimpleTexting @ 11:30 AM ET, durable outbox

## Context

MarketingHub v1 ships templates + console UI (branch `feat/console-ui`) on ECS/ALB over self-hosted Supabase. This feature adds **SMS campaigns**: marketing staff pick a `text` template, a **Monday.com board** (patient names + phones), and a date; every recipient gets one SMS via the **SimpleTexting v2 API** at **11:30 AM America/New_York** (DST-aware) on that date. Hundreds of recipients per campaign. Durable: no lost or duplicated sends across crashes/deploys/outages; pausable/cancelable/resumable; per-recipient audit; permanent STOP suppression.

Verified externals (2026-07-22): SimpleTexting v2 `POST /api/messages` (`{contactPhone, text, mode}`, bearer auth, base `https://api-app2.simpletexting.com/v2/api`) **has no scheduling field** — all scheduling is ours. Their campaigns API is immediate-only. Delivery-report + unsubscribe webhooks configured in their UI (payload shapes undocumented → tolerant parser + raw audit). Rate limits undocumented → configurable throttle (default 2/s). Monday: GraphQL `api.monday.com/v2`, bearer + `API-Version: 2024-01`, `items_page(limit:500)`/`next_items_page(cursor)` pagination, `... on PhoneValue { phone country_short_name }`. **No Monday board is linked yet** → token/board are runtime config; feature degrades gracefully when unconfigured (callout in UI, worker idles).

**Compliance guardrails:** SimpleTexting signs no BAA → **no PHI in message content** (permanent UI warning + runbook note). 11:30 ET is inside TCPA quiet hours. STOP → suppression list enforced at creation, claim, and pre-send.

## Architecture

Postgres **outbox** in the existing `marketinghub` schema (4 tables + counts view + claim RPC; dated idempotent migration in `cdk/sql/`, RLS FORCE deny-all per table — the rls-gate hard-requires it). All data access stays on PostgREST/supabase-js like the rest of the app, so row claiming (`FOR UPDATE SKIP LOCKED`) lives in a Postgres function called via `.rpc()`. The Next.js app owns campaign CRUD, Monday board preview, and the SimpleTexting webhook. A new **dispatcher worker** — same Docker image, separate esbuild-bundled `worker.cjs` entrypoint, second small ECS Fargate service (desiredCount 1, `minHealthyPercent 0/max 100` so deploys never run two dispatchers) — polls the outbox, claims due rows, sends throttled sequential SMS with **at-most-once-per-attempt** semantics.

Branch: `feat/sms-campaigns` off `feat/console-ui` (the UI builds on the console shell/ui-kit). Plan doc also committed to `docs/superpowers/plans/2026-07-22-sms-campaigns.md` per repo convention. No `git push`, no `cdk deploy`, no SQL applied to any DB, no external API calls — source + tests only.

## State machines

**Campaign** (`sms_campaigns.status`): `scheduled → sending` (dispatcher promotion when `send_at <= now()`); `sending → completed` (dispatcher drain check: zero rows in pending/claimed/sending); `scheduled|sending ⇄ paused` and `→ canceled` (API PATCH); `completed → sending` (recipient retry re-opens). Resume goes `paused → scheduled` — the dispatcher's promotion query is the single "actively dispatching" decision point.

**Recipient** (`sms_campaign_recipients.status`): created as `pending` | `skipped` (invalid/dupe/non-US phone) | `suppressed` (already on STOP list). `pending →(claim RPC)→ claimed →(conditional update, attempts+1)→ sending →` then by send result: `sent` (201) | `failed` (definitive 4xx, or retryable exhausted) | back to `pending` with backoff (`429/502/503/504`/pre-connection errors, attempts < 3) | `failed_ambiguous` (timeout/`ECONNRESET`/`500` — request may have been processed). `sent →(webhook)→ delivered|undelivered`. `failed_ambiguous →(webhook reconciliation)→ delivered|sent`, or `→(manual review API)→ pending (retry) | failed`. Terminal: delivered, undelivered, failed, suppressed, skipped, canceled.

**At-most-once decision (the durability core):** `attempts` increments on the durable `claimed → sending` transition — it counts POST attempts *started*. Crash recovery in the claim RPC: expired `claimed` → `pending` (no POST started, provably duplicate-free retry); expired `sending` → `failed_ambiguous` (**never auto-retried** — a duplicate patient text is worse than a missed one; webhook reconciliation or a human resolves it). `401/403` = config error → release + compensate attempts + abort batch + 5-min backoff (a bad token must not burn a campaign to `failed`).

**Pause/cancel vs claimed rows:** PATCH releases `claimed → pending` (pause) or `→ canceled` (cancel); the dispatcher's `claimed → sending` update is conditional (`.eq('status','claimed')`) so released rows match 0 rows and are skipped. Claim RPC only claims from campaigns in `sending`. In-flight POST (max 1, sequential) completes naturally.

## Data model — `cdk/sql/2026-07-22-sms-campaigns.sql`

House style: first-line path comment, idempotent, no DROP, service_role grants, ENABLE+FORCE RLS + do-block-guarded restrictive deny-all policy **per table**, header note to run `select pg_notify('pgrst','reload schema')` after apply.

- **`sms_campaigns`**: id uuid pk, name, template_id → templates(id), monday_board_id, monday_phone_column_id, `message_body` (template snapshot), `send_date` date, `send_at` timestamptz (computed 11:30 ET instant), status check (scheduled|sending|paused|completed|canceled), created_by, created_at/updated_at. Index `(status, send_at)`.
- **`sms_campaign_recipients`** (the outbox): id, campaign_id fk cascade, monday_item_id, name, first_name, `phone_e164` nullable, `rendered_text` (per-recipient snapshot, audit), status check (pending|claimed|sending|sent|delivered|undelivered|failed|failed_ambiguous|suppressed|skipped|canceled), attempts int, `send_after` timestamptz (= send_at; backoff bumps it), claimed_at, claim_expires_at, st_message_id, st_credits, last_error, timestamps. `unique (campaign_id, phone_e164)` — **duplicate rows marked `skipped` must carry `phone_e164 = null`** (raw phone noted in `last_error`) or they'd violate this; nulls are distinct so multiple skipped rows coexist. Partial indexes: `(send_after) where status='pending'`, `(claim_expires_at) where status in ('claimed','sending')`; plus campaign_id, st_message_id, phone_e164.
- **`sms_suppressions`**: phone_e164 pk, reason ('stop'|'manual'), raw jsonb, created_at.
- **`sms_webhook_events`**: id, received_at, kind ('unsubscribe'|'delivery_report'|'unknown'), raw jsonb, matched_recipient_id.
- **View** `sms_campaign_recipient_counts` (`security_invoker = true`): campaign_id × status × count.
- **Claim RPC** `claim_due_sms_recipients(batch_size int default 25, claim_ttl_seconds int default 180) returns setof sms_campaign_recipients`, `security invoker`, plpgsql, four steps: (1) due pending rows on suppression list → `suppressed`; (2) expired `claimed` → `pending` (safe); (3) expired `sending` → `failed_ambiguous`; (4) claim due pending rows joined to campaigns `where c.status='sending'`, `order by send_after limit batch_size for update of r skip locked`, set claimed/claim_expires_at, return rows. **`grant execute … to service_role; revoke execute … from public, anon, authenticated`** (Postgres grants EXECUTE to PUBLIC by default — the revoke is load-bearing).

All other transitions are conditional PostgREST updates (`.update({...}).eq('id',id).eq('status',expected)`) — row count = won/lost.

## Dispatcher worker — `web/src/worker/`

`createDispatcher(deps, config)` with injected deps (repo fns, sendSms, sleep, now) for deterministic tests. Config from env with defaults: `SMS_POLL_INTERVAL_MS=30000`, `SMS_CLAIM_BATCH=25`, `SMS_CLAIM_TTL_S=180`, `SMS_SEND_RATE_PER_SEC=2`, `MAX_ATTEMPTS=3`, HTTP timeout 15 s. Tick: promote due campaigns → drain loop (claim batch → fetch campaign statuses once → per row: release if campaign no longer `sending` or shutting down; belt-and-suspenders suppression check; conditional `markSending` (attempts+1, pass known value — PostgREST can't increment server-side; safe because `.eq('status','claimed')` guards it); `sendSms`; classify → markSent/markFailed/markRetry(backoff 60s·2^(attempts−1))/markAmbiguous/config-abort) → throttle sleep between POSTs → >50% errors → 60 s backpressure → `completeDrainedCampaigns`. SIGTERM: release un-attempted claims, never interrupt in-flight POST, exit 0. Missing `SIMPLETEXTING_API_TOKEN` → idle-with-warning loop (healthy task, graceful degradation); missing SUPABASE env → fail-loud crash.

**Bundling:** esbuild devDependency; `"build:worker": "esbuild src/worker/index.ts --bundle --platform=node --format=cjs --target=node24 --alias:server-only=./src/worker/shims/server-only.ts --outfile=.worker/worker.cjs"`. `--format=cjs` + `.cjs` is deliberate (`web` is `"type":"module"`; ESM bundles of supabase-js's CJS dep chain break on dynamic require). The `server-only` shim (`export {}`) is mandatory — the real package throws at import outside Next. Dockerfile: builder `RUN npm run build && npm run build:worker`; runner `COPY --from=builder /app/.worker/worker.cjs ./worker.cjs`; ECS command override `['worker.cjs']` (distroless ENTRYPOINT is `node`). `.worker/` → `.gitignore`. Nothing under `src/app/` may import `src/worker/`.

## Phases (strict TDD: failing test → red → impl → green → commit)

### Phase 1 — Migration + grep test — `cdk/` (independent)
`cdk/sql/2026-07-22-sms-campaigns.sql`, `cdk/test/sms-campaigns-sql.test.ts` (mirror `templates-sql.test.ts`): assert 4 tables created if-not-exists + no drops; exact status check-constraint state sets; `unique (campaign_id, phone_e164)`; partial + lookup indexes; RPC contains `for update of r skip locked`, the three recovery UPDATEs, `c.status = 'sending'`; grant-to-service_role AND revoke-from-public/anon/authenticated; grants block; per-table ENABLE+FORCE RLS + deny-all policy; `security_invoker = true` view; pgrst reload note.

### Phase 2 — Pure core libs — `web/src/lib/sms/` (independent; contract for 3–8; NO server-only imports)
- `schema.ts`: `CAMPAIGN_STATUSES`/`RECIPIENT_STATUSES` as-const arrays matching state machines; `CampaignCreateInputSchema` (name, templateId uuid, mondayBoardId — accepts raw id or pasted Monday URL via `/boards\/(\d+)/` transform, mondayPhoneColumnId, sendDate `YYYY-MM-DD`); row interfaces `SmsCampaign`, `SmsCampaignRecipient`, `CampaignCounts` (snake_case = DDL).
- `phone.ts`: `normalizeUsPhone(raw, countryShortName?)` → `+1XXXXXXXXXX` or null (US only; handles formatting, leading 1, rejects bad area codes).
- `render.ts`: `{{name}}`/`{{firstName}}` merge fields (case/space tolerant), `unsupportedMergeFields()`, `firstNameOf()`, `renderSms()`.
- `schedule.ts`: `sendAtForEasternDate('YYYY-MM-DD')` → UTC instant of 11:30 America/New_York, dependency-free via Intl.formatToParts offset iteration. Tests: EST (Jan → 16:30Z), EDT (Jul → 15:30Z), DST transition days 2026-03-08 (15:30Z) and 2026-11-01 (16:30Z), invalid input throws.

### Phase 3 — SimpleTexting client — `web/src/lib/simpletexting/client.ts` (independent)
`import "server-only"`. `isSimpleTextingConfigured()`; `sendSms({phone, text})` POSTs `<base>/messages` (test asserts the exact full URL — the `/v2/api` + `/messages` join is an easy bug), bearer auth, `{contactPhone, text, mode:'AUTO', accountPhone?}` (from optional `SIMPLETEXTING_ACCOUNT_PHONE`), `AbortSignal.timeout(15000)`. Returns discriminated `SendResult`, **never throws**: 201→`sent` (id, credits); 400/404/422→`permanent`; 401/403→`config`; 429/502/503/504/ECONNREFUSED/ENOTFOUND/EAI_AGAIN→`retryable`; 500/timeout/ECONNRESET→`ambiguous`. Full classification-table test coverage including fetch-rejection paths.

### Phase 4 — Monday client — `web/src/lib/monday/` (after Phase 2)
`client.ts`: `mondayGraphQL<T>(query, vars)` → `api.monday.com/v2`, bearer + `API-Version: 2024-01`; typed `MondayConfigError` (route → 503) / `MondayApiError` (HTTP ≠ 200 or GraphQL `errors[]`); `isMondayConfigured()`. `boards.ts`: `getBoardMeta(boardId)` → `{id,name,columns:[{id,title,type}]}` | null; `fetchBoardRecipients(boardId, phoneColumnId)` — paginate until cursor null, PhoneValue extraction, `normalizeUsPhone` → `{mondayItemId, name, firstName, phoneE164|null, rawPhone}[]`; 3-page mock proves pagination.

### Phase 5 — Campaigns repo — `web/src/lib/sms/repo.ts` (after 1-shape + 2)
Model on `templates/repo.ts` (`server-only`, `getServiceClient().schema("marketinghub")`, fail-loud `[sms]` prefix; extend the chainable-thenable test stub with `rpc/in/upsert/lte`).
- Creation: `prepareRecipients(mondayRows, body, suppressedSet)` (pure: dedupe-by-phone keeps first — **dupes get `phone_e164:null` + skipped**, null-phone → skipped, suppression hits → suppressed, `rendered_text` via renderSms); `getSuppressedSet(phones)` (chunked `.in()`); `createCampaign(input, recipients, user)` (campaign row w/ `message_body` + `send_at` snapshot; chunk-insert 200; chunk failure → best-effort campaign `canceled` + fail loud; **not transactional — acceptable at hundreds, documented**).
- Reads: `listCampaignsWithCounts()`, `getCampaign(id)`, `getCampaignRecipients(id)` (cap 2000), `getCampaignCounts(id)` (via the view).
- Transitions (all conditional; null → route 409): `pauseCampaign` (also releases claimed→pending), `resumeCampaign` (paused→scheduled), `cancelCampaign` (also pending|claimed→canceled), `retryRecipient` (failed_ambiguous|failed→pending, send_after=now, re-open completed→sending), `markRecipientFailed`.
- Dispatcher/webhook accessors: `claimDueRecipients` (rpc), `promoteDueCampaigns`, `markSending(id, knownAttempts+1)`, `markSent/markFailed/markRetry/markAmbiguous/releaseClaim/releaseForConfigError`, `isSuppressed`, `getCampaignStatuses(ids)`, `completeDrainedCampaigns`, `recordSuppression` (upsert), `suppressActiveRecipientsByPhone` (all campaigns), `recordWebhookEvent`, `findRecipientForDeliveryReport` (st_message_id first, else newest sent|sending|failed_ambiguous by phone), `applyDeliveryReport`.

### Phase 6 — API routes — `web/src/app/api/` (after 4 + 5)
House style: `dynamic="force-dynamic"`, `requireUser(req.headers,"marketing")` + authErrorResponse (except webhook), zod safeParse → 400 + issues, Next 15 awaited params, node-env route tests with real ES256 tokens via `lib/__test__/albToken.ts`.
- `campaigns/route.ts`: POST (validate; template exists + `type==='text'` + no unsupported merge fields; sendDate's 11:30 ET must be future; fetch ALL Monday pages; prepare; create; 201 `{id, counts}`; `MondayConfigError` → 503) + GET list.
- `campaigns/[id]/route.ts`: GET `{campaign, counts, recipients}` / 404; PATCH `{action: pause|resume|cancel}` → 200/409/400.
- `campaigns/[id]/recipients/[recipientId]/route.ts`: PATCH `{action: retry|mark_failed}` → 200/409/400.
- `monday/board-preview/route.ts`: POST `{board}` → 200 `{boardId, boardName, columns, phoneColumns, suggestedPhoneColumnId, sample (first 25 prepared), pageCounts}` / 503 / 404. First page only (creation refetches all).
- `webhooks/simpletexting/route.ts`: `?token=` vs `SIMPLETEXTING_WEBHOOK_TOKEN`, length-guarded `timingSafeEqual`, 401 before any storage; then always-200: tolerant classifier — unsubscribe-ish (`/unsub/i`, `action:'STOP'`) → recordSuppression + suppressActiveRecipientsByPhone; delivery-ish (message id + `/deliver/i` vs `/undeliver|fail/i`) → findRecipientForDeliveryReport → applyDeliveryReport (**this is also the failed_ambiguous auto-reconciliation lane**); else `unknown`. Every request → `sms_webhook_events` raw row (malformed JSON wrapped as `{unparsed: text}`). No `lib/auth` import.

### Phase 7 — Dispatcher worker + bundling — `web/src/worker/`, `package.json`, `Dockerfile` (after 3 + 5)
- `dispatcher.ts` + tests (node env, fake deps/timers): full matrix — promotion; claim→send→markSent with throttle-gap assertions; paused-mid-batch releases; markSending race-loss skips; every SendResult kind → right repo call; retryable exhaustion → failed; config → release+compensate+abort+5-min backoff; >50% errors → backpressure; drain-stop on empty; completeDrainedCampaigns; SIGTERM releases remaining + exits.
- `index.ts`: `buildConfigFromEnv()` (tested), fail-loud SUPABASE env, idle-with-warning when SimpleTexting unconfigured, signal handlers, one structured log line per tick.
- `shims/server-only.ts`, esbuild script, Dockerfile 2-line diff, `.gitignore`. Smoke: `node .worker/worker.cjs` fails with the SUPABASE_URL message (proves bundle+shim), not an import crash.

### Phase 8 — Console UI — `web/src/app/(app)/campaigns/`, `components/campaigns/` (after 6)
- Nav: add `{href:'/campaigns', label:'SMS Campaigns', icon:'campaigns'}` to Build group + IconKey SVG; update AppShell test if it enumerates items.
- `campaigns/page.tsx` (server): requireMarketingUser → listCampaignsWithCounts → PageHeader + DataTable (name, status Badge, send date/time in mono, counts) + empty state. `statusBadge.ts` tone map (failed/ambiguous = the only red; sending = running; delivered/completed = ok; paused = warning).
- `campaigns/new/page.tsx` (server) + `NewCampaignForm` (client): template select (text-only, body preview, unsupported-merge-field inline error); board input + Load board → board-preview POST → phone-column select (suggested pre-selected) + sample table + valid/invalid/duplicate counts; date input min = today-in-ET; **permanent PHI warning callout** ("SimpleTexting has not signed a BAA. Message content must contain NO PHI — no conditions, medications, appointment or treatment details."); submit → POST → `router.push`; unconfigured → Surface callout naming the runbook. `.surface` styling, no banned patterns.
- `campaigns/[id]/page.tsx` (server) + `CampaignActions` (pause/resume/cancel per status, PATCH + `router.refresh()`, cancel confirm + "in-flight message may still send" note) + `RecipientsTable` (status badges, attempts, last_error, st_message_id mono; failed_ambiguous rows get Retry / Mark failed buttons → recipient PATCH).

### Phase 9 — app-infra — `app-infra/` (independent of web; shared contract = `worker.cjs` + env names)
- 9.1 **First**: add `smsSecretsArn` to test CONTEXT; rewrite the exact-ARN GetSecretValue test to an allowlist of both secret ARNs (still no wildcards) — do this before wiring or the red is misattributed.
- 9.2 Secret: `req('smsSecretsArn')` (both modes; cdk.json REPLACE_ME), `fromSecretCompleteArn`; app container adds secrets `MONDAY_API_TOKEN`, `SIMPLETEXTING_WEBHOOK_TOKEN` (assert `:FIELD::` ValueFrom, present in preview too). Same CMK as Supabase secrets → no new KMS statement (runbook mandates the CMK).
- 9.3 Worker service (created BEFORE the preview early-return — both modes): second TaskDef cpu 256/mem 512, container `worker`, same image, `Command: ['worker.cjs']`, no port mappings, env SUPABASE_URL, secrets SUPABASE_SERVICE_ROLE_KEY + SIMPLETEXTING_API_TOKEN, awslogs prefix `marketinghub-sms-worker`; second Service desiredCount 1, `MinimumHealthyPercent 0 / MaximumPercent 100`, private subnets, no public IP, SGs = [new no-ingress WorkerSg, internalClientSg]; replicate ECR-pull + kms:Decrypt on the worker exec role. Optional `simpletextingAccountPhone` context via `tryGetContext` (not `req`). Verify the iterate-all-taskdefs tests still pass.
- 9.4 Webhook listener rule (prod branch only): priority 20, pathPatterns `['/api/webhooks/simpletexting']` + httpRequestMethods `['POST']`, forward-only — clone the `/api/health` rule + test.
- 9.5 cdk.json context default; `npm test` + synth clean both modes.

### Phase 10 — Runbook + settings (after 7 + 9)
- Settings page: "SMS Campaigns" section with configured/unconfigured chips (booleans only, never values).
- Runbook: §1.6 apply migration (SSM → `docker exec supabase-db psql -U postgres -v ON_ERROR_STOP=1 -f …` + `pg_notify('pgrst','reload schema')` — PostgREST won't see the new RPC otherwise); §1.7 create `marketinghub/sms-campaigns` JSON secret (3 fields, may be empty = degraded, **existing Supabase-secrets CMK**, complete ARN, `openssl rand -hex 32` webhook token, where to mint Monday/SimpleTexting tokens); §3 context rows; §4 post-deploy SimpleTexting webhook config → `https://<appHostname>/api/webhooks/simpletexting?token=…`; §5 smoke tests (worker log stream ticks; 1-recipient self-test campaign → arrives 11:30 ET; STOP → suppression; pause/resume; unconfigured degradation); §7 gotchas (no-PHI/no-BAA, suppression permanent, cancel can't recall in-flight, failed_ambiguous review procedure, never two workers, at-most-once policy). Self-review checklist.

## Execution strategy (ultracode, after approval)

Waves via Workflow with `isolation: 'worktree'` for parallel phases (each agent commits on its own branch; I merge sequentially — file-disjoint by design):

```
Wave 1: Phase 1 (cdk) ∥ Phase 2 (pure libs) ∥ Phase 3 (ST client) ∥ Phase 9 (app-infra)
Wave 2: Phase 4 (Monday) ∥ Phase 5 (repo)
Wave 3: Phase 6 (API) ∥ Phase 7 (worker)
Wave 4: Phase 8 (UI)      Wave 5: Phase 10 (runbook/settings)
```

Then an adversarial review wave (multi-lens finders + verify) over the full diff, fixes applied, full verification re-run.

## Verification

- `web`: `npm test` (all new + 138 existing green), `npx tsc --noEmit`, `npm run build`, `npm run build:worker` + `node .worker/worker.cjs` fail-loud smoke; `docker build` if the daemon is available (else note).
- `app-infra`: `npm test` (41 existing + new), `cdk synth` clean in prod-context and preview modes.
- `cdk`: `npm test` (126 existing + new grep suite).
- Manual e2e is deploy-gated (runbook §5) — not performed here.

## Risks / gotchas
1. `server-only` throws in the worker without the esbuild alias shim — the `node worker.cjs` smoke is the guard.
2. Must be `--format=cjs` + `.cjs` (`web` is type:module).
3. RPC EXECUTE revoke from public/anon is load-bearing (grep-tested).
4. PostgREST schema cache — new tables/RPC 404 until `pg_notify('pgrst','reload schema')`.
5. Exact-ARN IAM test breaks the moment the second secret lands — fix assertion first (9.1).
6. Deploy overlap can briefly run two dispatchers — SKIP LOCKED keeps it safe; min 0/max 100 avoids it.
7. SimpleTexting URL join + undocumented webhook payloads — tolerant parser + raw event audit; expect post-launch heuristic tuning from stored events.
8. Monday phone columns are sometimes `text` type — v1 suggests `type==='phone'` columns but accepts any column id; normalizer handles both.
9. `attempts+1` is a guarded read-modify-write — never remove the `.eq('status','claimed')` guard.
10. WAF applies to the webhook POST — small JSON should pass CommonRuleSet; documented fallback if smoke test 403s.
11. Suppression enforced at three points (creation, claim RPC, pre-send) — keep all three.
