# Guided Mode — live in-app documentation (2026-08-13)

**Ask (Justin):** a Guided Mode toggle (graduation-cap icon) next to the light/dark
toggle. When ON, hovering any function raises a concise plain-English popover —
live documentation for users brand-new to Supabase. When OFF (the default), the
UI is byte-identical to today: this is the sanctioned home for explanatory prose
under the terse-console doctrine (no explainer text in panes; guidance is opt-in).

## Architecture

**Axis (mirrors the theme axis exactly).** `lib/guided.ts`: `mh-guided`
localStorage key, `data-guided="on"` on `<html>` (absent when off),
`getGuided/setGuided/initGuided`, plus a `useGuided()` hook backed by
`useSyncExternalStore` and a `mh-guided-change` custom event — server pages
can't thread context, so client islands subscribe to the store directly.
`app/layout.tsx` gains a guided bootstrap line in the pre-hydration script
(same no-flash guarantee as the theme).

**Toggle.** `components/GuidedToggle.tsx` next to `ThemeToggle` in the
masthead: same `Surface`/`seg-btn` pattern, graduation-cap SVG, `aria-pressed`,
title "Turn guided mode on/off". Mount-gated state read (the ThemeToggle
hydration pattern).

**Primitive.** `components/guide/Guide.tsx` — `<Guide id="...">{control}</Guide>`.
- Mode OFF (or unmounted): renders children in a pass-through wrapper, zero
  listeners, zero visual change.
- Mode ON: wrapper gets a subtle affordance (CSS keyed off `html[data-guided]`),
  and hover OR keyboard focus raises the popover after a short delay; Escape /
  blur / mouseleave dismisses. `role="tooltip"` + `aria-describedby`.
  Position: fixed, viewport-aware (flips above/below, clamps horizontally) —
  no new dependency; a small measure-on-open hook.
- Unknown id: renders children untouched (fail-quiet in prod, loud in dev/test).

**Copy registry.** `lib/guides/` — one module per domain
(`nav.ts`, `database.ts`, `sql.ts`, `storage.ts`, `authAdmin.ts`,
`integrations.ts`, `observability.ts`, `campaigns.ts`, `engagement.ts`,
`intel.ts`, `apiDocs.ts`, `overview.ts`) merged by `index.ts` with a
duplicate-id guard. Entries: `{ title: string; body: string }`, ids namespaced
`<domain>.<surface>.<control>`. Copy is curated in these files, never inline in
JSX — reviewable in one place, and parallel agents never touch each other's
files.

**Copy rules (encoded in every writer prompt):**
- Plain English for someone who has never used Supabase. Define the concept,
  not the button ("Row Level Security decides which rows each user may see"),
  then what clicking does and when you'd use it.
- Title ≤ 5 words; body 1–2 sentences, ≤ 220 chars. No jargon without an
  in-line definition. Never restate the obvious ("Save saves your changes").
- Honest about consequences: destructive actions say so; degraded states
  (missing tokens) say what's missing.

## Waves

1. **Foundation (inline, this session):** axis + bootstrap + toggle + primitive
   + registry infra + CSS + unit tests (mirror ThemeToggle/AlertDialog test
   style). Gate: typecheck + targeted tests.
2. **Annotation fan-out (ultracode workflow, ~12 agents, disjoint ownership):**
   each agent owns one domain's pages/components subtree + its own
   `lib/guides/<domain>.ts`. Shared files each have exactly ONE owner
   (Nav.tsx → nav agent). Wrap every meaningful control; write the copy.
3. **Adversarial review (workflow):** dimensions — hydration/SSR safety, a11y,
   copy quality vs the rules above, registry integrity (every referenced id
   resolves; no orphans), zero-regression when OFF (snapshot-level), perf.
   Verify → fix root causes.
4. **Gates + ship:** typecheck, build, full web suite, e2e personas. Commit on
   feat/supabase-parity; stage /tmp deploy script (Justin runs, WORKER pinned —
   no worker code in this feature).

## Non-goals (this round)

- No walkthrough/tour sequencing (step 1→2→3) — hover documentation only.
- No per-user server persistence (browser localStorage, like the theme).
- No mobile/touch long-press affordance — desktop tool.
