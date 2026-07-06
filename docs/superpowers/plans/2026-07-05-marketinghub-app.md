# MarketingHub App — Campaign Templates + Cognito Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Build phases IN ORDER (each consumes the prior). Strict TDD: failing test → run it red → minimal impl → green → commit. Commit after every green test. Do NOT `git push` (the orchestrator pushes). Do NOT `cdk deploy` / `terraform apply` / any AWS mutation — implementation = source + tests only (`npm test`/`vitest` green, `cdk synth` clean, `next build` clean, `tsc` clean).

**Goal:** Ship v1 of the MarketingHub web app — a Socrates-style internal tool where marketing staff log in with Cognito (Google Workspace SAML) and upload, name, tag, categorize, browse, and search **text and email campaign templates**, stored on the self-hosted MarketingHub Supabase backend.

**Architecture:** A Next.js 15 (App Router, TypeScript) app served as a container on **ECS Fargate behind an ALB** whose HTTPS:443 listener is gated by `authenticate-cognito` federated to the NSight Google Workspace SAML app — the exact front-door pattern already implemented in this repo's `cdk/lib/edge-stack.ts` (Phase 4 of the Supabase build) and in Socrates. The app **does not** use Supabase GoTrue for login; identity comes from the ALB's OIDC/Cognito headers, and app-layer authz is by Cognito group. Template **files** live in a Supabase **Storage** bucket (S3-backed); template **metadata** (name, category, tags, type, subject, body, owner, timestamps) lives in **Supabase Postgres**, with Postgres full-text search (`tsvector` + GIN) over name/category/tags/body. The app's server (Next.js Route Handlers / server actions) is the only thing that talks to Supabase — via a service connection (PostgREST with the `service_role` key + the Storage S3 API), never the browser — so PHI-free campaign content stays server-mediated and Cognito remains the sole auth authority.

**Tech Stack:** Next.js 15 + React 19 + TypeScript 5; `@supabase/supabase-js` (server-side, service role) for Postgres + Storage; Postgres full-text search; Vitest + React Testing Library (unit/component) + Playwright (e2e, mocked auth); AWS CDK v2 (TypeScript) for the app's ECS/ALB/Cognito/WAF stack (new `app-infra/` CDK app, reusing EdgeStack constructs); Docker (distroless Node 24) like `lena-admin`. Node 24, us-east-1, account `439024109088`.

**Repo:** Monorepo in `JButtsNsight/MarketingHub`. New top-level dirs: `web/` (Next.js app) and `app-infra/` (CDK for the app). Existing `cdk/` (Supabase infra), `docs/`, and `sql/` are untouched except the new Supabase migration in `cdk/sql/` (see Phase 2).

---

## Design principles (apply to EVERY UI task — this is the acceptance bar for "looks right")

Source of truth: `~/NSight-Design-Language/docs/2026-05-30-design-language-spec.md` + `~/NSight-Design-Language/options/bento.html` (reference exemplar) + `~/Documents/Liquid-Glass-Web-Guide.md`. Agents MUST read the spec before Phase 1 Task 2.

- **Palette (token-driven, light/dark):** light — canvas `#ECE4D3`, paper `#F5EFE2`, wash `#E2D8C2`; ink `#16303F`, ink-2 `#36505C`, muted `#766F5C`, faint `#A89F88`; text `--tx` graphite `#3B3A36`; hairline `rgba(21,48,63,.14)`. Dark — canvas `#0C1E22`, paper `#13292E`, wash `#0A191D`; ink `#EAF2EE`, ink-2 `#C2D2CD`, muted `#8FA49B`; `--tx` eggshell `#F0EAD6`; hairline `rgba(255,255,255,.12)`. Brand accent = teal `#64A6A7` (one living accent), navy `#132E3F`, coral `#FF8766` (logo/avatar only). Status: ok `#5E8E5A`/`#84C08A`, running `#4E7FA6`/`#7FB0DA`, warning `#E87B2E`, **failed `#D24747`/`#FF6363` (only red)**. Category coding uses the fixed data pool (orange `#C58A4D`, steel `#5E8CA6`, seafoam `#6FA89B`, violet `#7068AE`, grape `#844E84`, silver `#97A0A8`, slate `#7B86A8`, charcoal `#45494C`) — assigned by position, never red.
- **Type:** Marcellus (display/headlines), DM Sans (UI/body), IBM Plex Mono (IDs/timestamps/counts). Bundle fonts locally (`web/public/fonts`) — CDN is blocked on the network.
- **Material — unfrosted liquid glass:** semantic surface tokens `--surface-bg`, `--surface-border`, `--surface-rim` (top specular), `--surface-shade` (bottom inner shadow), `--surface-shadow` (drop), `--surface-glint`, resolved per `data-skin` (`glass`|`flat`) × `data-theme` (`light`|`dark`) on `<html>`. Every elevated component (card, panel, button, input, select, modal, toolbar, nav, chip, tab, table row) is built from these tokens or a shared `.surface` primitive. **No `backdrop-filter`/blur** — the page gradient reads through the glass; light source above-and-to-the-right. Glass ↔ Flat is a global toggle; Flat = transparent/no chrome (content lifts via its own shadow).
- **Motion:** functional only (hover magnification, pulse for attention). Restrained.
- **Banned ("the Claude look"):** violet/indigo gradients, emoji bullets/sparkles, centered floating three-card hero, default system font, clinical white backgrounds, decorative color, glowing status spheres, atmosphere light-burst blobs.

---

## File structure (created across phases)

```
web/
  package.json  tsconfig.json  next.config.mjs  vitest.config.ts  playwright.config.ts  Dockerfile  .dockerignore
  public/fonts/                      # Marcellus, DM Sans, IBM Plex Mono (woff2)
  src/
    styles/tokens.css                # all palette + surface tokens (Phase 1)
    styles/globals.css               # base, .surface primitive, type scale (Phase 1)
    lib/theme.ts                     # data-theme/data-skin get/set + persistence (Phase 1)
    lib/auth.ts                      # parse ALB Cognito/OIDC headers -> {email,name,groups}; requireUser() (Phase 3)
    lib/supabase.ts                  # server-only service-role client (PostgREST + Storage) (Phase 2)
    lib/templates/schema.ts          # zod schemas + Template type (Phase 2)
    lib/templates/repo.ts            # data access: create/list/search/get + file upload/download (Phase 2/4)
    components/Surface.tsx           # .surface primitive wrapper (Phase 1)
    components/AppShell.tsx  Nav.tsx  ThemeSkinToggle.tsx  UserMenu.tsx (Phase 1/3)
    components/templates/UploadForm.tsx  TemplateCard.tsx  TemplateGrid.tsx  SearchBar.tsx  FilterChips.tsx  TemplatePreview.tsx (Phase 4)
    app/layout.tsx  app/page.tsx     # shell + redirect to /templates (Phase 1)
    app/(auth)/login/page.tsx        # login landing (Phase 3)
    app/templates/page.tsx           # list/search/browse (Phase 4)
    app/templates/new/page.tsx       # upload (Phase 4)
    app/templates/[id]/page.tsx      # view/preview (Phase 4)
    app/api/templates/route.ts       # GET(list/search) POST(create) (Phase 4)
    app/api/templates/[id]/route.ts  # GET(one) (Phase 4)
    app/api/health/route.ts          # ALB health check (Phase 5)
  test/ …                            # colocated *.test.tsx + e2e/
app-infra/
  package.json tsconfig.json cdk.json jest.config.js bin/marketinghub-app.ts
  lib/app-stack.ts                   # ECS Fargate + ALB + authenticate-cognito + WAF + Route53 (Phase 3/5)
  test/app-stack.test.ts
cdk/sql/2026-07-05-templates.sql     # Supabase schema migration (Phase 2)
docs/runbooks/marketinghub-app-deploy.md (Phase 5)
```

---

## Non-goals (v1 — YAGNI; state in self-review)

Competitor-intel module (separate later plan; that one uses Supabase pgvector/RAG). Template **editing/versioning** in-place (v1 is upload + metadata + read; re-upload replaces). Template **sharing links / send-to-ESP**. Rich WYSIWYG editor. Per-user RBAC beyond a single `marketing` Cognito group (+ existing admin group). Analytics/usage dashboards. i18n. Supabase GoTrue login (Cognito is the only auth).

---

## Phase 1 — App scaffold + NSight design system

**Goal:** A running Next.js 15 app with the full NSight token system, the `.surface` liquid-glass primitive, theme+skin toggles, and the app shell (nav + header) — no data yet.

**Files:** `web/package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `src/styles/tokens.css`, `src/styles/globals.css`, `src/lib/theme.ts`, `src/components/Surface.tsx`, `AppShell.tsx`, `Nav.tsx`, `ThemeSkinToggle.tsx`, `src/app/layout.tsx`, `src/app/page.tsx`.

### Task 1.0 — Scaffold
- [ ] Create `web/` Next.js 15 App-Router TS project (no `create-next-app` network scaffold if blocked; hand-write `package.json` with `next@15`, `react@19`, `typescript@5`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`). Add scripts `dev/build/start/test/typecheck`. `npm install`.
- [ ] Verify `npx tsc --noEmit` and `npm run build` succeed on the empty app. Commit `chore(web): scaffold Next.js 15 + vitest`.

### Task 1.1 — Design tokens (TDD via a token contract test)
- [ ] **Failing test** `src/styles/tokens.test.ts`: parse `tokens.css`, assert the required token names exist for all four `data-skin`×`data-theme` combos (`--surface-bg/border/rim/shade/shadow/glint`, `--canvas/--paper/--ink/--tx/--accent/--status-failed`) and that `--status-failed` resolves to `#D24747` (light) / `#FF6363` (dark) and no `backdrop-filter` appears anywhere.
- [ ] Run red. Implement `tokens.css` with the palette above, per-`data-theme` blocks and per-`data-skin` surface tokens (glass = directional-light gradients + rim/shade/shadow/glint; flat = transparent + own drop shadow). Local `@font-face` for Marcellus/DM Sans/IBM Plex Mono. Run green. Commit.

### Task 1.2 — `.surface` primitive + `Surface.tsx`
- [ ] **Failing component test**: `<Surface>` renders children, applies `.surface` class, and passes `data-elevated`; assert it carries no inline `backdrop-filter`. Implement `globals.css` `.surface` (consumes the tokens only) + `Surface.tsx`. Green. Commit.

### Task 1.3 — Theme + skin toggle (`lib/theme.ts` + `ThemeSkinToggle.tsx`)
- [ ] **Failing test**: `setTheme('dark')`/`setSkin('flat')` set `document.documentElement.dataset.theme/skin` and persist to `localStorage`; `initTheme()` restores. Implement. Toggle component is a segmented control built from `.surface`. Green. Commit.

### Task 1.4 — App shell (`AppShell`, `Nav`, `layout.tsx`, `page.tsx`)
- [ ] **Failing test**: `AppShell` renders the NSight wordmark (Marcellus), a left nav with a "Templates" item, the theme/skin toggle, and a `<main>`; `page.tsx` renders a redirect to `/templates`. Implement shell using `.surface` nav; NO banned patterns (no centered 3-card hero, no violet). Green. Commit.

**Acceptance:** `npm run build` + `npx tsc --noEmit` clean; `npm test` green; shell renders in `next dev` with working light/dark × glass/flat toggles; visual matches NSight spec (agent self-checks against `options/bento.html`).

---

## Phase 2 — Supabase data layer (schema + server client + repo)

**Goal:** The Postgres schema + Storage bucket for templates and a typed, server-only data-access module. Consumes the Supabase backend built in `cdk/` (Postgres + Storage).

**Files:** `cdk/sql/2026-07-05-templates.sql`, `web/src/lib/supabase.ts`, `web/src/lib/templates/schema.ts`, `web/src/lib/templates/repo.ts` (create/list/search/get metadata; file upload/download in Phase 4 Task 4.2 extends it).

### Task 2.1 — Schema migration SQL
- [ ] Create `cdk/sql/2026-07-05-templates.sql` (idempotent). Contents:
  - `create schema if not exists marketinghub;`
  - `create table marketinghub.templates ( id uuid primary key default gen_random_uuid(), name text not null, type text not null check (type in ('text','email')), category text not null, tags text[] not null default '{}', subject text, body text not null, storage_path text, created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), search tsvector generated always as ( setweight(to_tsvector('english', coalesce(name,'')), 'A') || setweight(to_tsvector('english', array_to_string(tags,' ')), 'B') || setweight(to_tsvector('english', coalesce(category,'')), 'B') || setweight(to_tsvector('english', coalesce(body,'')), 'C') ) stored );`
  - `create index templates_search_idx on marketinghub.templates using gin (search);`
  - `create index templates_category_idx on marketinghub.templates (category);`
  - `create index templates_tags_idx on marketinghub.templates using gin (tags);`
  - A private Storage bucket `campaign-templates` (documented as created via Supabase Storage API on first deploy; include the SQL/`storage.buckets` insert form as a comment for the deploy runbook).
- [ ] **Validation test** `cdk/test/templates-sql.test.ts` (grep-style, like the Phase-5 gate assets): assert the file defines the generated `tsvector`, the GIN index, the `type` check constraint, and no `drop table`. Run green. Commit.

### Task 2.2 — Server Supabase client (`lib/supabase.ts`)
- [ ] **Failing test**: `getServiceClient()` throws if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env are unset (fail-loud), and is server-only (module has `import 'server-only'`). Implement using `@supabase/supabase-js` `createClient(url, serviceRoleKey, { auth: { persistSession:false } })`. Green. Commit.

### Task 2.3 — Zod schema + types (`lib/templates/schema.ts`)
- [ ] **Failing test**: `TemplateInput` zod schema rejects empty name, invalid `type`, and (when `type==='email'`) missing `subject`; accepts a valid text and a valid email input; `tags` normalized to lowercase-trimmed unique. Implement. Green. Commit.

### Task 2.4 — Repo: metadata create/list/search/get (`lib/templates/repo.ts`)
- [ ] **Failing test** (mock the Supabase client): `createTemplate(input, user)` inserts a row with `created_by=user.email`; `listTemplates({category?, type?})` filters; `searchTemplates(q)` calls PostgREST full-text (`.textSearch('search', q, {type:'websearch'})`); `getTemplate(id)` returns one or null. Implement against the mocked client (real integration deferred to Phase 4 e2e). Green. Commit.

**Acceptance:** `npm test` green; `tsc` clean; SQL migration validates; repo is fully server-only and typed.

---

## Phase 3 — Auth: Cognito Google-SAML via ALB + app identity

**Goal:** The app's front-door CDK stack (ECS Fargate + ALB `authenticate-cognito` + Cognito Google-SAML + WAF), and app-side identity extraction from the ALB headers with a `marketing`/admin group gate — matching Socrates and the existing `cdk/lib/edge-stack.ts`.

**Files:** `app-infra/` CDK app (`bin/marketinghub-app.ts`, `lib/app-stack.ts`, `test/app-stack.test.ts`), `web/src/lib/auth.ts`, `web/src/components/UserMenu.tsx`, `web/src/app/(auth)/login/page.tsx`.

### Task 3.1 — Scaffold `app-infra/` CDK (mirror `cdk/` config)
- [ ] Create `app-infra/package.json`/`tsconfig.json`/`cdk.json`/`jest.config.js`/`bin/marketinghub-app.ts` (aws-cdk-lib ^2.150, account `439024109088`, us-east-1, context-driven). `npm install`. Commit.

### Task 3.2 — `AppStack` (TDD with `aws-cdk-lib/assertions`)
Reuse the EdgeStack pattern from `../cdk/lib/edge-stack.ts` (read it first). Assert, one failing test per property:
- [ ] Cognito User Pool (RETAIN) + Hosted-UI domain (context `cognitoDomainPrefix`) + Google SAML IdP (`CfnUserPoolIdentityProvider` `ProviderType:'SAML'`, `MetadataURL` from context `googleSamlMetadataUrl` — the NSight Google Workspace app) + code-flow app client (callback `https://<appHostname>/oauth2/idpresponse`) + admin/`marketing` `CfnUserPoolGroup`.
- [ ] Public internet-facing ALB; HTTPS:443 listener whose **default action is `AuthenticateCognitoAction` → forward** to the Fargate service target group (unlike EdgeStack's Studio-only rule, here the whole app is authed), with an unauthenticated `/api/health` path exception; `sslPolicy: RECOMMENDED_TLS`; access logs to a retained SSE bucket.
- [ ] ECS Fargate service (Node 24 distroless task image placeholder ref via context `appImageTag`), desired count 2, in private subnets, SG allowing 443 from the ALB SG only; ACM cert (DNS-validated, context hosted zone) for `appHostname`.
- [ ] WAFv2 REGIONAL (CommonRuleSet + KnownBadInputs + rate limit) + association.
- [ ] Route53 A/ALIAS for `appHostname`.
- [ ] Fail-loud `req()` context helper (as EdgeStack). Env-driven: `appHostname`, `hostedZoneId/Name`, `googleSamlMetadataUrl`, `adminGroup`, `marketingGroup`, `cognitoDomainPrefix`, `appImageTag`, plus `SUPABASE_URL`/secret ARN passed to the task as env/secret. Commit after each green assertion.

### Task 3.3 — App identity (`lib/auth.ts`)
- [ ] **Failing test**: `getUser(headers)` decodes the ALB `x-amzn-oidc-data` JWT (base64url payload; verification of the ALB signature is via the documented ALB public-key step — for v1 trust the ALB since the app is only reachable through it, and assert we read `email`, `name`, `cognito:groups`); `requireUser(headers, group)` throws/redirects if the user lacks `group`. Implement. Green. Commit.
- [ ] `UserMenu.tsx` shows email + sign-out (`/logout` → Cognito logout URL); `(auth)/login/page.tsx` is the pre-auth landing (rarely seen since ALB gates everything). `.surface` styled. Test + commit.

**Acceptance:** `cd app-infra && npm test` green + `npx cdk synth` clean (with placeholder context); `web` auth unit tests green; group-gate enforced server-side.

---

## Phase 4 — Templates feature (upload, tag/categorize, browse, search, preview)

**Goal:** The end-to-end template experience wired to Phase 2's repo + Supabase Storage.

**Files:** extend `web/src/lib/templates/repo.ts` (file upload/download); `web/src/app/api/templates/route.ts`, `app/api/templates/[id]/route.ts`; pages `app/templates/page.tsx`, `new/page.tsx`, `[id]/page.tsx`; components `UploadForm`, `TemplateCard`, `TemplateGrid`, `SearchBar`, `FilterChips`, `TemplatePreview`.

### Task 4.1 — API route handlers (server, group-gated)
- [ ] **Failing tests**: `POST /api/templates` requires the `marketing` group (via `requireUser`), validates with the zod schema, calls `createTemplate`, returns 201 + id; `GET /api/templates?q=&category=&type=` returns search/filter results; `GET /api/templates/[id]` returns one/404. Implement Route Handlers using `repo.ts`. Green. Commit.

### Task 4.2 — Storage: upload/download the template file (`repo.ts` extension)
- [ ] **Failing test** (mock Storage): `createTemplate` also uploads the raw file to bucket `campaign-templates` at `storage_path = <id>/<safe-filename>` and stores `storage_path`; `getTemplateFile(id)` returns a signed URL / bytes. Implement via `supabase.storage.from('campaign-templates')`. Green. Commit.

### Task 4.3 — Upload UI (`UploadForm` + `new/page.tsx`)
- [ ] **Failing component test**: form has fields name, type (text|email), category (select from a fixed starter list: `Newsletter, Promotion, Onboarding, Transactional, Announcement, Other`), tags (chip input), subject (shown only when type=email), body (textarea) OR file drop (accepts `.txt`, `.html`, `.eml`); submit posts to `/api/templates` and redirects to the new template. Client validation mirrors the zod schema. Implement, `.surface` styled. Green. Commit.

### Task 4.4 — Browse + search + filter (`TemplateGrid`, `TemplateCard`, `SearchBar`, `FilterChips`, `templates/page.tsx`)
- [ ] **Failing tests**: `SearchBar` debounces and updates the `q` query param; `FilterChips` toggles category/type filters (category chips colored from the data pool by position); `TemplateGrid` renders `TemplateCard`s (name in Marcellus, category chip, tag chips, type badge, `created_at` in IBM Plex Mono); `templates/page.tsx` (server component) reads `q/category/type` from searchParams, calls the repo, renders results + empty state. Implement. Green. Commit.

### Task 4.5 — View / preview (`TemplatePreview` + `[id]/page.tsx`)
- [ ] **Failing test**: for `type='text'` renders the body in a monospace-safe `.surface` panel; for `type='email'` renders `subject` + an **HTML preview** of the body in a sandboxed `<iframe srcDoc>` (no script exec) with a "source" toggle. Metadata sidebar (category, tags, owner, timestamps). Implement. Green. Commit.

**Acceptance:** `npm test` green; `npx next build` clean; `tsc` clean; a Playwright e2e (Task 5.3) drives upload→search→view against a mocked auth header and a local/mocked Supabase.

---

## Phase 5 — Containerize, app-infra wiring, e2e, deploy runbook

**Goal:** Ship-ready packaging + tests + a human deploy runbook. No deploy performed.

**Files:** `web/Dockerfile`, `web/.dockerignore`, `web/src/app/api/health/route.ts`, `web/playwright.config.ts` + `web/test/e2e/templates.spec.ts`, finalize `app-infra/lib/app-stack.ts` service→image wiring, `docs/runbooks/marketinghub-app-deploy.md`.

### Task 5.1 — Health route + Dockerfile (distroless Node 24, like lena-admin)
- [ ] `GET /api/health` returns 200 `{status:'ok'}` (unauthenticated; ALB health check + the listener path exception from 3.2). Test + commit.
- [ ] Multi-stage `Dockerfile`: builder `node:24-alpine` (`next build`, standalone output) → runtime `gcr.io/distroless/nodejs24`. `.dockerignore`. Verify `docker build` succeeds locally IF Docker is available; otherwise `bash -n`/hadolint-lint the Dockerfile and note it. Commit.

### Task 5.2 — Wire image + Supabase env/secret into `AppStack`
- [ ] Task def env: `SUPABASE_URL` (context), `NEXT_PUBLIC_APP_NAME`; secret: `SUPABASE_SERVICE_ROLE_KEY` from Secrets Manager ARN (context `supabaseServiceRoleSecretArn`) via `ecs.Secret.fromSecretsManager`, IAM `grantRead` on the exact ARN (no wildcard). Update `app-stack.test.ts` to assert the secret + env are present and the IAM is ARN-scoped. Green. Commit.

### Task 5.3 — Playwright e2e (mocked auth + Supabase)
- [ ] `templates.spec.ts`: inject a fake `x-amzn-oidc-data` header (marketing group), stub the repo/Supabase, walk upload → appears in grid → search finds it → open preview. Run headless. Commit.

### Task 5.4 — Deploy runbook
- [ ] `docs/runbooks/marketinghub-app-deploy.md`: prereqs (Supabase stack deployed + `campaign-templates` bucket created + service-role secret ARN; NSight Google-SAML app callback `https://<appHostname>/oauth2/idpresponse` + logout URLs registered; ACM/DNS; `marketing` Google group → Cognito group mapping), then build+push image → set `app-infra` context → `cdk deploy` order → smoke test. Commit.

**Acceptance:** `web`: `npm test` + `next build` + `tsc` all green, Playwright e2e green, Dockerfile builds/lints. `app-infra`: `npm test` + `cdk synth` clean. Runbook complete.

---

## Self-review checklist (run before handoff)
- Spec coverage: login (P3) ✓, upload text+email (P4.3/4.2) ✓, name/tag/categorize (P2.3/4.3) ✓, search+filter later (P2.4/4.4) ✓, preview (P4.5) ✓, NSight+Liquid-Glass (P1 + every UI task) ✓, Cognito-like-Socrates (P3) ✓, Supabase backend (P2) ✓.
- No `git push` / no `cdk deploy` anywhere (orchestrator pushes; deploy is the runbook). ✓
- Types consistent across phases: `Template`, `TemplateInput`, `getUser`, `requireUser`, `createTemplate/listTemplates/searchTemplates/getTemplate`, tokens. ✓
- Deferred (non-goals) explicitly listed. ✓
