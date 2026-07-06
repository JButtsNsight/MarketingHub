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

  it("binds the one living accent to the governed brand teal #64A6A7", () => {
    // Spec §2.1: teal #64A6A7 is "the one living accent"; raw off-palette hex is a lint error.
    expect(ruleBody(":root")).toContain("--teal:#64A6A7");
    // --accent must reference the governed teal token, not a freehand hex, in both themes.
    expect(ruleBody(":root")).toContain("--accent:var(--teal)");
    expect(ruleBody('html[data-theme="dark"]')).toContain("--accent:var(--teal)");
  });

  it("resolves --status-failed to #D24747 (light) and #FF6363 (dark)", () => {
    expect(ruleBody(":root")).toContain("--status-failed:#D24747");
    expect(ruleBody('html[data-theme="dark"]')).toContain(
      "--status-failed:#FF6363",
    );
  });

  it("defines all six surface tokens for every data-skin × data-theme combo", () => {
    const combos = [
      'html[data-skin="flat"]',
      'html[data-skin="glass"]',
      'html[data-theme="dark"][data-skin="flat"]',
      'html[data-theme="dark"][data-skin="glass"]',
    ];
    for (const sel of combos) {
      const body = ruleBody(sel);
      expect(body, `selector ${sel} not found`).not.toBe("");
      for (const t of SURFACE_TOKENS) {
        expect(body, `${sel} missing ${t}`).toContain(t + ":");
      }
    }
  });
});
