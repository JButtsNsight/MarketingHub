# Wave D: RBAC-in-the-UI — tiers + sections, live admin checks

Date: 2026-08-12. Branch feat/supabase-parity (tip 8dedf2d, PROD LIVE at
https://marketinghub.nsightcare.com, app td :42). Scope approved by Justin:
tiers + sections / near-instant revocation on Admin surfaces / groups fixed
in code.

## Role model (fixed registry, single source of truth)
`web/src/lib/authGroups.ts` grows a SECTIONS registry shared by gates, nav,
and the roles UI:
- `marketing` (existing) — base access: sign-in, Overview, the Marketing nav
  group (templates, campaigns, lists, inbox, review, suppressions, reports).
  KEEPS its historical meaning; every user needs it.
- `mh-section-platform` (new) — Platform + Integrations nav groups: Table
  Editor, SQL Editor (incl. assistant), Database, Storage, API docs, Cron,
  Queues, Webhooks. Routes/APIs currently marketing-gated move to
  requireSection('platform') = group OR god-mode.
- `mh-section-intel` (new) — /intel pages + /api/intel/*.
- `marketinghub-admins` (existing) — god-mode: implies every section + the
  Admin area. requireSection always passes for admins.
MIGRATION NOTE: users holding only `marketing` lose console+intel until
granted sections (correct per Justin's "section off things"; Justin is
god-mode so unaffected). Nav filters per section (Nav already takes groups).

## Live admin checks (near-instant revocation where it matters)
`web/src/lib/cognitoAdmin.ts` (server-only, new dep
@aws-sdk/client-cognito-identity-provider — web app only, NOT the worker
bundle): pool ops via task-role creds, env COGNITO_USER_POOL_ID (already on
task-def). `liveGroupsFor(email)` = ListUsers(email filter) →
AdminListGroupsForUser, in-process TTL cache 60s, fail-open to TOKEN groups
(never lock admins out on a Cognito blip — log loud).
requireAdminUser() consults live groups (token groups as fallback);
section/marketing gates stay token-based (next-sign-in latency accepted,
ALB session stays 12h).

## Users & Roles UI
New /admin/users page (Admin nav group): Cognito pool users table (email,
status, created, groups as chips), per-user section toggles + god-mode
toggle. Guards: cannot remove YOUR OWN god-mode (lockout prevention,
server-enforced); every grant/revoke logged loud (structured console log).
APIs: GET /api/console/cognito/users, POST /api/console/cognito/grants
{username, group, action} — both admin-gated (live check), zod-validated,
group name must be in the fixed registry. Terse UI per house rules.
/admin/auth (GoTrue views) unchanged — this is the Cognito surface.

## /login stub fix (folds in)
(auth)/login/page.tsx: if getUser() returns a user with NO groups → render
"Signed in as <email> — awaiting access. Ask an admin." (no button). If no
session → button becomes a real link to /overview (any protected route
re-triggers ALB auth; the old href="/" loop dies with honest states).

## Infra (CDK)
- CfnUserPoolGroups: mh-section-platform, mh-section-intel (existing two
  untouched).
- App task ROLE IAM: cognito-idp ListUsers/ListGroups/AdminListGroupsForUser/
  AdminAddUserToGroup/AdminRemoveUserFromGroup scoped to the pool ARN.
- No new env (pool/client ids already aboard td :42).

## Gates & deploy
typecheck + build + full suites (web/app-infra), adversarial review
(security dims: privilege escalation via grants API, lockout, live-check
fail-open abuse, registry drift), commit, then Justin runs deploy-prod.sh
(expect: AppTaskDef image + task-role policy + 2 new pool groups; broker
NO-OP as always).
