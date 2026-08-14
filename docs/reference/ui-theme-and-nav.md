# UI reference — themes and the nav rail

State as of 2026-08-13 (`parity-b52ed45` and later).

## Themes

One axis on `<html>`: `data-theme="light|dark"`, controlled by the masthead
sun/moon toggle, persisted to `localStorage["mh-theme"]` (`web/src/lib/theme.ts`).
Default is light. Surfaces are always flat (the glass skin is retired); every
color resolves through the token layer — no freehand hex in components.

| | Light — "Dawn" | Dark — "Dusk", inky navy |
|---|---|---|
| canvas (page field) | `#ECE4D3` warm sand | `#081422` |
| paper (panels) | `#F5EFE2` | `#0C1D30` |
| wash (rails) | `#E2D8C2` | `#050C16` |
| accent | `var(--teal)` `#64A6A7` | `var(--teal)` `#64A6A7` |
| type | Geist Sans + IBM Plex Mono (both themes; Marcellus wordmark only) | same |

Source of truth: `web/src/styles/tokens.css` (locked by
`web/src/styles/tokens.test.ts` — palette hexes, accent bindings, both-theme
surface tokens, no `backdrop-filter`, no retired theme axes).

### History / spec divergence

The dark theme's 2026-08-13 arc: Supabase Studio look (`#1c1c1c` + `#3ECF8E`
green, retired) → NSight spec "Dusk" petrol (`#0C1E22`, read too green at page
scale) → brand navy `#132E3F` field (read too teal and too light) → **inky
navy** (final, picked from a side-by-side mock). The shipped surfaces
deliberately depart from the design-language spec's Dusk petrol values
(`~/Documents/NSight-Design-Language-for-Claude.md` §1); accent, status set,
eggshell knockout `--tx`, and the fixed chart data pool keep spec values. If
other NSight tools should match this dark, the spec doc needs a small update —
owed, not done.

Iterating on theme colors: don't deploy per guess. Clone the side-by-side
mock pattern (a static HTML file binding candidate palettes onto the app-shell
markup, variant buttons swapping CSS custom properties) and have the owner
pick before shipping once.

## Nav rail (`web/src/components/Nav.tsx`)

- `NAV_GROUPS` is the IA: Overview (unlabeled) → Platform → Integrations →
  Marketing → Admin → Project. Platform mirrors Supabase Studio's order.
- RBAC display filtering via `navGroupsFor(admin, sections, marketing)` —
  display only; routes are the enforcement.
- **Collapsible groups** (2026-08-13): every labeled group header is a
  disclosure button with a rotating chevron (`.nav-group-toggle` /
  `.nav-chev` in `globals.css`). State persists per browser as a JSON array
  of collapsed labels in `localStorage["mh-nav-collapsed"]`, restored
  after mount (SSR renders expanded — avoids hydration mismatch). A collapsed
  group containing the active route tints its header with the accent
  (`.nav-group-toggle.on`) so location is never hidden.
- `.nav-group-label` (the plain span face) is still used by the SQL console
  rails and Table Editor schema rail — don't remove it when touching nav CSS.

## Guided mode

The masthead graduation-cap toggle (`GuidedToggle`) turns on hover
documentation for annotated controls. Copy lives in `web/src/lib/guides/*`
(one module per domain; `nav.ts` owns the rail + masthead). Registry rules are
test-enforced (`index.test.ts`): ids `domain.surface.control`, titles ≤ 5
words / ≤ 40 chars, bodies 1–2 sentences ≤ 240 chars, every `guideId`
referenced in code must resolve. Group-header entries describe the
collapse/expand behavior; keep them in sync if the rail interaction changes.
