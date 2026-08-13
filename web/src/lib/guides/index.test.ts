import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDES } from "./index";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every <Guide id="..."> string literal in the source tree. */
function usedGuideIds(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    // JSX literals, plus `guideId` carried in data (nav items etc.) — the
    // convention for any id that reaches <Guide> through a variable.
    for (const re of [/<Guide\b[^>]*?\bid="([^"]+)"/gs, /\bguideId(?:=|:\s*)"([^"]+)"/g]) {
      for (const m of text.matchAll(re)) {
        const arr = used.get(m[1]) ?? [];
        arr.push(file);
        used.set(m[1], arr);
      }
    }
  }
  return used;
}

describe("guide registry integrity", () => {
  it("every <Guide id> used anywhere in src resolves in the registry", () => {
    const missing: string[] = [];
    for (const [id, files] of usedGuideIds()) {
      if (!GUIDES[id]) missing.push(`${id} (${files.join(", ")})`);
    }
    expect(missing, `unresolved guide ids:\n${missing.join("\n")}`).toEqual([]);
  });

  it("ids are namespaced domain.surface.control in kebab-case", () => {
    for (const id of Object.keys(GUIDES)) {
      expect(id).toMatch(/^[a-z][a-z-]*(\.[a-z0-9][a-z0-9-]*){2,}$/);
    }
  });

  it("copy obeys the rules: title ≤ 5 words / ≤ 40 chars; body 1–2 sentences ≤ 240 chars", () => {
    const violations: string[] = [];
    for (const [id, e] of Object.entries(GUIDES)) {
      if (!e.title.trim() || !e.body.trim()) violations.push(`${id}: empty copy`);
      if (e.title.length > 40) violations.push(`${id}: title > 40 chars`);
      if (e.title.trim().split(/\s+/).length > 5)
        violations.push(`${id}: title > 5 words`);
      if (e.body.length > 240) violations.push(`${id}: body > 240 chars`);
      if (/\.\s*$/.test(e.title)) violations.push(`${id}: title ends with a period`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
