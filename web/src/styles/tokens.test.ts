import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(process.cwd(), "src/styles/tokens.css"),
  "utf8",
);
// Collapse whitespace to make token/value assertions robust to formatting.
const flat = css.replace(/\s+/g, "");

/** Extract the body of the first CSS rule whose selector text matches `selector`. */
function ruleBody(selector: string): string {
  const idx = flat.indexOf(selector + "{");
  if (idx === -1) return "";
  const start = idx + selector.length + 1;
  const end = flat.indexOf("}", start);
  return flat.slice(start, end);
}

const SURFACE_TOKENS = [
  "--surface-bg",
  "--surface-border",
  "--surface-rim",
  "--surface-shade",
  "--surface-shadow",
  "--surface-glint",
];

const PALETTE_TOKENS = [
  "--canvas",
  "--paper",
  "--ink",
  "--tx",
  "--accent",
  "--status-failed",
];

describe("tokens.css", () => {
  it("never uses backdrop-filter (unfrosted liquid glass)", () => {
    expect(css.toLowerCase()).not.toContain("backdrop-filter");
  });

  it("defines the core palette tokens on the light :root base", () => {
    const root = ruleBody(":root");
    for (const t of PALETTE_TOKENS) {
      expect(root, `:root missing ${t}`).toContain(t + ":");
    }
  });

  it("defines dark-theme overrides for the palette", () => {
    const dark = ruleBody('html[data-theme="dark"]');
    for (const t of PALETTE_TOKENS) {
      expect(dark, `dark theme missing ${t}`).toContain(t + ":");
    }
  });

  it("binds LIGHT's living accent to the governed brand teal #64A6A7", () => {
    // Spec §2.1: teal #64A6A7 is "the one living accent" in the NSight light
    // theme; raw off-palette hex there is a lint error.
    expect(ruleBody(":root")).toContain("--teal:#64A6A7");
    expect(ruleBody(":root")).toContain("--accent:var(--teal)");
  });

  it("DARK is 'Dusk' anchored on the brand navy — nsightcare.com chrome + governed teal accent", () => {
    const dark = ruleBody('html[data-theme="dark"]');
    expect(dark).toContain("--canvas:#081422"); // page field — inky navy (variant B, 2026-08-13)
    expect(dark).toContain("--paper:#0C1D30"); // panels — one lift above the field
    expect(dark).toContain("--teal:#64A6A7"); // the governed brand teal, same value as light
    expect(dark).toContain("--accent:var(--teal)"); // dark binds the living accent like light does
    expect(dark).toContain('--fd:"GeistSans"'); // type stays unified (whitespace collapsed by `flat`)
    expect(dark).toContain('--fu:"GeistSans"');
    // Retired Supabase-era values — comments stripped (they legitimately record the swap).
    const noComments = dark.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(noComments).not.toContain("#3ecf8e");
    expect(noComments).not.toContain("#1c1c1c");
    expect(noComments).not.toContain("Inter");
  });

  it("unifies type on Geist Sans across BOTH themes; mono stays IBM Plex Mono", () => {
    // Per product direction (2026-08): one sans everywhere. The display face
    // (--fd) may only differentiate via weight/size, never family.
    for (const sel of [":root", 'html[data-theme="dark"]']) {
      const body = ruleBody(sel);
      expect(body, `${sel} --fd`).toContain('--fd:"GeistSans"');
      expect(body, `${sel} --fu`).toContain('--fu:"GeistSans"');
      expect(body, `${sel} --fm`).toContain('--fm:"IBMPlexMono"');
    }
    // Retired light-theme faces — comments stripped (they legitimately record
    // the swap).
    const noComments = flat.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(noComments).not.toContain("Marcellus");
    expect(noComments).not.toContain("DMSans");
  });

  it("resolves --status-failed to #D24747 (light) and Dusk red #FF6363 (dark)", () => {
    expect(ruleBody(":root")).toContain("--status-failed:#D24747");
    expect(ruleBody('html[data-theme="dark"]')).toContain(
      "--status-failed:#FF6363",
    );
  });

  it("defines all six surface tokens in both themes (flat-only)", () => {
    for (const sel of [":root", 'html[data-theme="dark"]']) {
      const body = ruleBody(sel);
      expect(body, `selector ${sel} not found`).not.toBe("");
      for (const t of SURFACE_TOKENS) {
        expect(body, `${sel} missing ${t}`).toContain(t + ":");
      }
    }
  });

  it("ships no glass skin — the data-skin axis is gone", () => {
    expect(css).not.toContain("data-skin");
  });

  it("ships exactly two themes — the retired 'supabase' block is gone", () => {
    expect(css).not.toContain('data-theme="supabase"');
  });
});

/* globals.css carries the theme-bound chrome that tokens.css deliberately
 * does not: the select dropdown affordance and the SQL editor syntax palette.
 * Both must resolve in BOTH themes (a light-only chevron or a light-only
 * token color silently vanishes / goes illegible on the dark chrome). */
const gcss = readFileSync(
  join(process.cwd(), "src/styles/globals.css"),
  "utf8",
);
const gflat = gcss.replace(/\s+/g, "");

/** Body of the first rule in globals.css whose (whitespace-collapsed) selector matches. */
function globalsRuleBody(selector: string): string {
  const idx = gflat.indexOf(selector + "{");
  if (idx === -1) return "";
  const start = idx + selector.length + 1;
  const end = gflat.indexOf("}", start);
  return gflat.slice(start, end);
}

describe("globals.css — select affordance", () => {
  it("gives styled selects a chevron + clearance in LIGHT (appearance is stripped)", () => {
    const body = globalsRuleBody("select.control");
    expect(body).toContain("appearance:none");
    expect(body).toContain("background-image:url(\"data:image/svg+xml");
    expect(body).toContain("stroke='%2336505C'"); // NSight ink-2
    expect(body).toContain("padding-right:34px");
  });

  it("re-binds the chevron for DARK (a dark glyph would vanish on the navy chrome)", () => {
    const body = globalsRuleBody('html[data-theme="dark"]select.control');
    expect(body).toContain("background-image:url(\"data:image/svg+xml");
    expect(body).toContain("stroke='%23C3D5E0'"); // Dusk ink-2 (navy-anchored)
  });
});

describe("globals.css — SQL editor syntax palette (.tok-*)", () => {
  it("LIGHT keeps CodeMirror's default keyword color (visually unchanged)", () => {
    expect(globalsRuleBody(".sqled.tok-keyword")).toContain("color:#708");
  });

  it("DARK re-binds keywords to the Dusk accent teal (the light purple was illegible)", () => {
    expect(
      globalsRuleBody('html[data-theme="dark"].sqled.tok-keyword'),
    ).toContain("color:#79c2c2");
  });

  it("DARK re-binds strings, numbers and comments off the light hex", () => {
    const darkStart = gflat.indexOf('html[data-theme="dark"].sqled.tok-keyword');
    const dark = gflat.slice(darkStart);
    expect(dark).toContain("color:#7dd3fc"); // strings
    expect(dark).toContain("color:#fbbf24"); // numbers/literals
    expect(dark).toContain(".tok-comment{color:var(--muted)");
  });
});
