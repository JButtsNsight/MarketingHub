/**
 * The guided-mode copy registry (plan docs/superpowers/plans/2026-08-13-guided-mode.md).
 * One module per domain; each module has EXACTLY ONE owner so parallel work
 * never collides. Copy lives here, never inline in JSX. Duplicate ids fail at
 * module load — loud in dev, test, and build.
 */
import type { GuideEntry, GuideModule } from "./types";
import { nav } from "./nav";
import { overview } from "./overview";
import { database } from "./database";
import { databasePlatform } from "./databasePlatform";
import { sql } from "./sql";
import { storage } from "./storage";
import { authAdmin } from "./authAdmin";
import { integrations } from "./integrations";
import { observability } from "./observability";
import { campaigns } from "./campaigns";
import { engagement } from "./engagement";
import { intel } from "./intel";
import { apiDocs } from "./apiDocs";

const MODULES: Record<string, GuideModule> = {
  nav,
  overview,
  database,
  databasePlatform,
  sql,
  storage,
  authAdmin,
  integrations,
  observability,
  campaigns,
  engagement,
  intel,
  apiDocs,
};

const merged: Record<string, GuideEntry> = {};
for (const [name, mod] of Object.entries(MODULES)) {
  for (const [id, entry] of Object.entries(mod)) {
    if (merged[id]) {
      throw new Error(`duplicate guide id "${id}" (in module "${name}")`);
    }
    merged[id] = entry;
  }
}

export const GUIDES: Readonly<Record<string, GuideEntry>> = merged;

/** The entry for a guide id, or undefined (Guide renders children untouched). */
export function guideFor(id: string): GuideEntry | undefined {
  return GUIDES[id];
}
