# Round 2: RBAC admin gating, SMS upgrades, intel corpus + assistant

Date: 2026-08-11. Branch: `feat/supabase-parity` (== main 9ff4b0a at plan time).
Scope approved by Justin: (A) God-Mode admin gating — **Admin nav surfaces only**;
(B) SMS per-recipient timezones + Monday write-back; (C) intel corpus seed from
`~/Downloads/Competitor Intel.xlsx` + live search smoke + W7 AI-assistant equivalent
on headless-claude (sign-off given with round scope, 2026-08-11).

Standing constraints: Studio-terse UI (one-line hints max); controls match risk;
migrations idempotent + deny-all RLS + pgrst reload note, applied as supabase_admin
via SSM (Justin runs); `gen-db-types.sh` re-run on any migration (hash guard);
deploys only via `app-infra/scripts/deploy-preview.sh`; Node 26 vitest gotcha;
never touch the 4-arg `claim_due_sms_recipients` RPC (engagement-suite applies LAST).

Wave order: A → B → C2 serially (app-stack.ts and shared-lib overlap); C1 corpus
seed runs in parallel against the LIVE preview (td :38 already has the intel API).

---

## Track A — RBAC: God-Mode admins

**Decision log**: group = existing `marketinghub-admins` (cdk.json `adminGroup`,
CfnUserPoolGroup already provisioned — no infra change). Gate scope = Admin nav
group only: pages `/admin/auth{,/users,/providers,/impersonate}`, `/admin/advisors`,
`/admin/cloud`, `/logs`, `/logs/drains`, `/infrastructure`; APIs
`/api/console/gotrue/users{,/[id]}`, `/api/console/impersonate`,
`/api/console/advisors`, `/api/console/logs`. SQL/Table/Storage editors stay
marketing-gated (follow-up flag: /sql runs as DB superuser — candidate for a later
admin gate). 403 UX: signed-in non-admin gets a terse 403 panel (NOT redirect to
/login — redirect-loop feel); APIs return 403 JSON. Nav hides the Admin group for
non-admins (display only; routes are the enforcement).

Build:
1. `web/src/lib/authGroups.ts` (new): export `MARKETING_GROUP`, `ADMIN_GROUP =
   "marketinghub-admins"`, `isAdmin(user)`. Re-point `requireMarketingUser.ts`'s
   constant; add `requireAdminUser()` sibling that renders/throws 403 (not /login).
2. Fix the PREVIEW_AUTH shim (`lib/auth.ts:136-143`): run the env value through
   the existing `parseGroups()` so `PREVIEW_AUTH="marketing,marketinghub-admins"`
   yields two groups. Add preview-only persona override: when PREVIEW_AUTH is set,
   honor cookie `mh-preview-persona=member` (drops the admin group) so both
   personas are reachable in one deploy. Never active when PREVIEW_AUTH unset.
3. app-infra: previewMode branch sets `PREVIEW_AUTH=marketing,marketinghub-admins`
   (app-stack.ts:653). deploy-preview.sh safety gate tolerates value changes.
4. Swap gates on the 9 pages + 5 API routes listed above. Pages render the terse
   403 panel component; APIs 403 JSON `{error:"admin-only"}`.
5. Nav: thread `user.groups` from `(app)/layout.tsx` (already calls getUser) →
   AppShell prop → `<Nav groups={filtered}>` (Nav already takes a groups prop).
   Settings page: surface the current personas honestly (preview chip).
6. Tests: auth.test.ts shim multi-group + persona cookie; requireAdminUser 403;
   per-route 403 tests; e2e clones `albToken()` with/without admin group
   (globalSetup.ts pattern) for nav visibility + route enforcement.

Acceptance: non-admin marketing user sees no Admin nav group, gets terse 403 on
direct URL + 403 JSON on APIs; admin sees everything; preview persona flip works;
prod path needs zero infra (group exists; membership manual per runbook §361-369).

## Track B — SMS: per-recipient timezones + Monday write-back

**Decision log**: recipient zone precedence = explicit member `timezone` column
(CSV header) → Monday timezone column (optional per-list config) → campaign zone
fallback. NO area-code inference (ported numbers lie). Zone values validated to
SEND_TIMEZONE_IDS, accepting IANA ids + ET/CT/MT/PT/HT abbrs; unknown → fallback +
per-row note, never a hard reject. `campaigns.send_at` = EARLIEST per-recipient
instant (promoteDueCampaigns unchanged; claim RPC untouched — already
send_after-driven). Recipients gain `send_timezone` (audit + reschedule recompute).
Past-slot check at create/reschedule validates against the earliest instant among
audience zones. Write-back = continuous idempotent sync (outcomes arrive late:
delivery reports/replies/opt-outs), new isolated worker consumer (intel-consumer
pattern), per-list configured outcome column (board-preview column picker), skips
CSV campaigns (`monday_board_id` null) and rows without `monday_item_id`.

Migrations (two new dated files, neither touches the claim RPC):
- `cdk/sql/2026-08-11-recipient-timezones.sql`: `contact_list_members.timezone
  text` (nullable), `contact_lists.monday_timezone_column_id text` (nullable),
  `sms_campaign_recipients.send_timezone text` (nullable).
- `cdk/sql/2026-08-11-monday-writeback.sql`: `contact_lists.monday_outcome_column_id
  text`, `sms_campaign_recipients.monday_synced_at timestamptz` +
  `monday_synced_status text` (idempotency: re-write only when current outcome
  differs from synced snapshot). Deny-all RLS boilerplate both files; re-run
  gen-db-types.sh; engagement-suite still applies LAST (RPC untouched).

Build:
1. Timezone capture: csv.ts TIMEZONE header candidates + ParsedContact field +
   createCsvList row map + ContactListMember iface; boards.ts optional
   `timezoneColumnId` (columnIds array + toRecipient); NewListForm + list-create
   API accept the Monday timezone column pick.
2. Stamping: SourceRecipientRow/PreparedRecipient carry zone; createCampaign
   computes per-row `send_after = sendAtForZonedSlot(date, time, zone ?? campaign
   zone)` + stamps `send_timezone`; campaign `send_at` = min(row instants).
   rescheduleCampaign recomputes per distinct pending-row zone (app-side loop).
3. Dispatch: NO worker changes for tz (send_after-driven already). 'sending' can
   now span ~6h ET→HT — completion detection unaffected.
4. Write-back: `web/src/lib/monday/writes.ts` (change_multiple_column_values or
   change_simple_column_value mutation + retry/backoff/throttle — client has NONE
   today); `web/src/worker/monday-writeback.ts` consumer (own setInterval, busy
   flag, try/catch-everything, idle-warn when MONDAY_API_TOKEN empty — never
   crash); started from worker/index.ts beside startIntelConsumer. Outcome
   mapping: terminal statuses + delivered/undelivered + replied/opted_out
   (phone-level, best-effort attribution as engagement view documents).
   Env knobs follow smsFreqCap* pattern (enable flag, poll interval, rate).
5. app-infra: WorkerTaskDef gains `MONDAY_API_TOKEN` secret (same smsSecrets ARN,
   no new KMS) — DOCUMENTED exception to runbook §9.4 secret-frozen-worker
   doctrine (update §9.4 wording).
6. UI (terse): NewCampaignForm zone picker relabeled as fallback zone when the
   list carries zones; detail/schedule pages show one slot chip + a "N zones"
   chip when multi-zone; RescheduleControl unchanged shape (recomputes per-zone);
   list detail shows outcome/timezone column config chips.
7. Tests: schedule/repo/dispatcher/csv/boards/writeback units following existing
   DI + PostgREST-fake patterns; app-infra snapshot for worker secret.

Acceptance: CSV with `timezone` column sends per-zone at the chosen slot;
Monday list with configured tz column same; zoneless lists behave exactly as
today (fallback, send_at identical); reschedule sweeps per-zone; write-back
idles honestly tokenless, syncs idempotently when token lands (LIVE SMOKE BLOCKED:
MONDAY_API_TOKEN empty in preview + needs WRITE scope — human action for Justin).

## Track C1 — Intel corpus seed + live smoke (ops, parallel, no app code)

Corpus: `~/Downloads/Competitor Intel.xlsx` — sheets Nsight (24 RPM competitors,
web/LinkedIn hyperlinks extracted from sheet XML) + Sales info (near-dup, 20
common + Coach Care/HBox) + Nvera (9 RCM competitors + comparison questions).
Shape (per recon: titles are citation chips, ONLY content is FTS-searched):
one **source per competitor** (kind 'url', url=website, notes=LinkedIn), one
short prose **document per topic** with `##` heading, competitor name verbatim
in content, merged across Nsight+Sales-info rows; Nvera → sources per RCM
company + one "RCM comparison questions" doc under source "Nvera notes".
Path: local script (repo `scripts/seed-intel-from-xlsx.mjs`, generic
xlsx-not-committed) → POST /api/intel/sources + /api/intel/documents through the
SSM tunnel (PREVIEW_AUTH satisfies requireUser; 3MiB cap irrelevant at this size).
Pre-flight: worker intel-consumer alive (CloudWatch log check) + corpus counts.
Post: poll documents to status=embedded (~10 docs/min), FTS probes, then gateway
answer smoke (citations render, "Ranked by Claude" badge, degraded honesty).

## Track C2 — W7 AI-assistant equivalent (console /sql panel)

**Decision log**: mount = /sql rail panel only (self-hosted Studio subset).
Egress = schema METADATA only (pg-meta tables/columns/policies), injection-
neutralized with the W8R helpers — row data / query results to the LLM is a NEW
egress decision, explicitly out of scope. Assistant NEVER executes SQL: proposes
into the editor via setDoc(); user's Run flows through the existing classify →
409 → confirmWrite path. Ephemeral chat (no persistence tables this round).
Reuse marketinghub/headless-claude env AS-IS (zero infra); new task namespace
`mh-sqlast-<uuid>` + own regex (poll relay stays a non-oracle); own globalThis
Symbol.for store + token bucket. Update /admin/cloud ASSISTANT_ROWS + feature-
catalog row 99 (skipped-pending-sign-off → live-equivalent).

Build: generalize lib/intel/gateway.ts prompt-hardening helpers (shared module),
route pair /api/console/assistant + /answer/[taskId] mirroring intel patterns
(dedupe, completed-cache, generic 502s, client-owned 90s deadline), rail panel in
SqlConsole with NL input + response (explanation + SQL block + "Insert into
editor"), terse copy. Tests: route units (auth 401/403, task-id oracle guard,
degraded mode), prompt-builder neutralization, panel behavior.

Acceptance: env present → NL question yields proposed SQL inserted-not-run;
env absent → honest one-line degraded state; foreign task ids rejected; nothing
auto-executes; /admin/cloud + catalog updated.

## Human action items (Justin)
1. Monday write-back live smoke needs a WRITE-scoped Monday token in
   `marketinghub/sms-campaigns` MONDAY_API_TOKEN (+ force new worker deployment).
2. Migrations apply via SSM as supabase_admin (scripts staged in /tmp as usual).
3. Prod day-one: add yourself to `marketinghub-admins` in the Cognito pool
   (manual mapping, runbook §361-369) — preview personas don't need this.

## Gates (every wave)
typecheck + build + full affected suites green (web/cdk/app-infra, zero
exclusions), adversarial review (ultracode), gen-db-types.sh after migrations,
commit per wave on feat/supabase-parity. Final: deploy-preview.sh, route
post-verify, live smoke, memory/handoff update.
