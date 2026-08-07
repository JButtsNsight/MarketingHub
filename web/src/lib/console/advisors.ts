import "server-only";

import { runQuery } from "./pgmeta";

/**
 * Security + performance advisors — the console's parity for Supabase Studio's
 * "Advisors" screen. Each check is a fixed, catalog-only SQL lint (no user
 * input reaches SQL here, so there is nothing to interpolate) that returns rows
 * shaped `{ schema, object, detail }`; the runner maps those into typed
 * `AdvisorLint`s carrying the check's id/severity/title/remediation.
 *
 * The runner is RESILIENT: a single check that errors (a catalog function that
 * differs across a Postgres point release, say) is reported in `failed` rather
 * than blowing up the whole dashboard — the other lints still render. Genuine
 * transport failures inside a check still surface pg-meta's real message.
 */

/** Schemas exposed via the data API — the surface these lints police. */
export const ADVISOR_SCHEMAS = ["public", "marketinghub"];

export type AdvisorLevel = "security" | "performance";
export type AdvisorSeverity = "error" | "warn" | "info";

export interface AdvisorLint {
  /** Stable check id (slug), e.g. "rls_disabled_in_exposed_schema". */
  id: string;
  level: AdvisorLevel;
  severity: AdvisorSeverity;
  title: string;
  /** Per-finding human detail (from the check row). */
  detail: string;
  schema: string | null;
  object: string | null;
  remediation: string;
}

export interface AdvisorReport {
  lints: AdvisorLint[];
  /** Checks whose SQL failed to run, with pg-meta's message. */
  failed: Array<{ id: string; error: string }>;
}

interface AdvisorCheck {
  id: string;
  level: AdvisorLevel;
  severity: AdvisorSeverity;
  title: string;
  remediation: string;
  /** Returns rows `{ schema, object, detail }`. */
  sql: string;
}

/** `in (...)` list of the exposed schemas as SQL literals (fixed, not user input). */
const SCHEMA_LIST = ADVISOR_SCHEMAS.map((s) => `'${s}'`).join(", ");

/**
 * The lint catalog. Fixed SQL only — ADVISOR_SCHEMAS is a module constant, so
 * SCHEMA_LIST is not user input.
 */
export const ADVISOR_CHECKS: readonly AdvisorCheck[] = [
  {
    id: "rls_disabled_in_exposed_schema",
    level: "security",
    severity: "error",
    title: "RLS disabled on an exposed table",
    remediation:
      "Enable and force row-level security, then add an explicit policy (or a deny-all restrictive policy).",
    sql: `select n.nspname as schema, c.relname as object,
                 'Table is reachable through the data API but row-level security is disabled' as detail
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'r'
             and n.nspname in (${SCHEMA_LIST})
             and not c.relrowsecurity
           order by 1, 2`,
  },
  {
    id: "rls_enabled_no_policy",
    level: "security",
    severity: "warn",
    title: "RLS enabled but no policy",
    remediation:
      "Add at least one policy, or confirm the table is intentionally deny-all for anon/authenticated.",
    sql: `select n.nspname as schema, c.relname as object,
                 'RLS is enabled but no policy exists, so all non-superuser access is denied' as detail
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'r'
             and c.relrowsecurity
             and n.nspname in (${SCHEMA_LIST})
             and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid)
           order by 1, 2`,
  },
  {
    id: "function_search_path_mutable",
    level: "security",
    severity: "warn",
    title: "Function with a mutable search_path",
    remediation:
      "Pin the function's search_path (e.g. `alter function ... set search_path = ...`) to prevent search-path hijacking.",
    sql: `select n.nspname as schema, p.proname as object,
                 'Function does not pin search_path; a hostile search_path could hijack unqualified references' as detail
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname in (${SCHEMA_LIST})
             and not exists (
               select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
                where cfg like 'search_path=%'
             )
           order by 1, 2`,
  },
  {
    id: "security_definer_view",
    level: "security",
    severity: "warn",
    title: "SECURITY DEFINER view",
    remediation:
      "Set `security_invoker = true` on the view so it runs with the querying user's privileges.",
    sql: `select n.nspname as schema, c.relname as object,
                 'View runs with its owner''s privileges (security_invoker is not enabled)' as detail
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'v'
             and n.nspname in (${SCHEMA_LIST})
             and coalesce((
               select option_value
                 from pg_catalog.pg_options_to_table(c.reloptions)
                where option_name = 'security_invoker'
             ), 'false') <> 'true'
           order by 1, 2`,
  },
  {
    id: "extension_in_public",
    level: "security",
    severity: "warn",
    title: "Extension installed in public",
    remediation:
      "Move the extension to a dedicated schema (`alter extension ... set schema ...`) to keep the public search path clean.",
    sql: `select 'public' as schema, e.extname as object,
                 'Extension is installed in the public schema' as detail
            from pg_catalog.pg_extension e
            join pg_catalog.pg_namespace n on n.oid = e.extnamespace
           where n.nspname = 'public'
             and e.extname <> 'plpgsql'
           order by 2`,
  },
  {
    id: "unindexed_foreign_key",
    level: "performance",
    severity: "warn",
    title: "Unindexed foreign key",
    remediation:
      "Add an index whose leading columns cover the foreign-key columns to avoid sequential scans on the child table.",
    sql: `select n.nspname as schema, cl.relname as object,
                 'Foreign key ' || con.conname || ' has no covering index' as detail
            from pg_catalog.pg_constraint con
            join pg_catalog.pg_class cl on cl.oid = con.conrelid
            join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
           where con.contype = 'f'
             and n.nspname in (${SCHEMA_LIST})
             and not exists (
               select 1 from pg_catalog.pg_index i
                where i.indrelid = con.conrelid
                  and con.conkey::int[] <@ string_to_array(i.indkey::text, ' ')::int[]
             )
           order by 1, 2`,
  },
  {
    id: "unused_index",
    level: "performance",
    severity: "info",
    title: "Unused index",
    remediation:
      "Confirm the index is genuinely unused (scans reset on restart) before dropping it to reclaim space and write throughput.",
    sql: `select schemaname as schema, indexrelname as object,
                 'Index has never been scanned since stats were last reset' as detail
            from pg_catalog.pg_stat_user_indexes
           where idx_scan = 0
             and schemaname in (${SCHEMA_LIST})
             and indexrelname not like '%\\_pkey'
           order by 1, 2`,
  },
  {
    id: "duplicate_index",
    level: "performance",
    severity: "warn",
    title: "Duplicate index",
    remediation: "Drop the redundant index; identical indexes only add write cost.",
    sql: `select n.nspname as schema,
                 min(c.relname) as object,
                 'Duplicate indexes on identical columns: ' || string_agg(ic.relname, ', ') as detail
            from pg_catalog.pg_index i
            join pg_catalog.pg_class ic on ic.oid = i.indexrelid
            join pg_catalog.pg_class c on c.oid = i.indrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname in (${SCHEMA_LIST})
           group by n.nspname, i.indrelid, i.indkey::text, i.indclass::text,
                    (i.indexprs is null), (i.indpred is null)
          having count(*) > 1`,
  },
] as const;

function toLint(check: AdvisorCheck, row: Record<string, unknown>): AdvisorLint {
  return {
    id: check.id,
    level: check.level,
    severity: check.severity,
    title: check.title,
    detail:
      typeof row.detail === "string" && row.detail.length > 0
        ? row.detail
        : check.title,
    schema: row.schema == null ? null : String(row.schema),
    object: row.object == null ? null : String(row.object),
    remediation: check.remediation,
  };
}

/** Run one check, returning its findings (may be empty). Throws on SQL error. */
export async function runAdvisorCheck(check: AdvisorCheck): Promise<AdvisorLint[]> {
  const rows = await runQuery(check.sql);
  return rows.map((r) => toLint(check, r));
}

/**
 * Run the advisor suite (optionally just one level) and return every finding
 * plus any checks that failed to execute. Findings are ordered
 * error → warn → info, then by id, so the most serious surface first.
 */
export async function runAdvisors(level?: AdvisorLevel): Promise<AdvisorReport> {
  const checks = ADVISOR_CHECKS.filter((c) => !level || c.level === level);
  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        return { ok: true as const, lints: await runAdvisorCheck(check) };
      } catch (err) {
        return {
          ok: false as const,
          id: check.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const severityRank: Record<AdvisorSeverity, number> = { error: 0, warn: 1, info: 2 };
  const lints = results
    .flatMap((r) => (r.ok ? r.lints : []))
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        a.id.localeCompare(b.id),
    );
  const failed = results
    .filter((r): r is { ok: false; id: string; error: string } => !r.ok)
    .map(({ id, error }) => ({ id, error }));

  return { lints, failed };
}
