"use client";

import { useState } from "react";

import { Guide } from "@/components/guide/Guide";
import { DataTable, type Column } from "../ui/DataTable";
import { StatCard } from "../ui/StatCard";
import { Section } from "../ui/Section";
import { Badge } from "../ui/Badge";
import { useConfirm } from "../ui/AlertDialog";

/**
 * Database → Triggers client island. Browsing is a plain read (no confirm); the
 * two writes — toggle enabled/disabled (an ALTER) and drop — each go behind the
 * interrupting confirm modal, matching the controls-match-risk rule (guard the
 * write, not the browse). Timing / events / function are parsed for DISPLAY
 * only; every action addresses the trigger by its structured schema/table/name,
 * which the route + foundation lib re-validate against live introspection.
 */

export interface TriggerDto {
  oid: number;
  schema: string;
  table: string;
  name: string;
  enabled: boolean;
  definition: string;
}

/** BEFORE | AFTER | INSTEAD OF, parsed from pg_get_triggerdef output. */
function parseTiming(def: string): string {
  return /\b(BEFORE|AFTER|INSTEAD OF)\b/i.exec(def)?.[1]?.toUpperCase() ?? "—";
}

/** The event list (e.g. "INSERT OR UPDATE") between the timing and `ON`. */
function parseEvents(def: string): string {
  const m = /\b(?:BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s/i.exec(def);
  return m ? m[1].replace(/\s+/g, " ").trim() : "—";
}

/** The executed function, e.g. "marketinghub.touch_updated_at()". */
function parseFunction(def: string): string {
  return /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(.+?)\s*$/i.exec(def)?.[1] ?? "—";
}

const keyOf = (t: TriggerDto) => `${t.schema}.${t.table}.${t.name}`;

export function TriggersClient({
  initialTriggers,
}: {
  initialTriggers: TriggerDto[];
}) {
  const [triggers, setTriggers] = useState(initialTriggers);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const refresh = async () => {
    try {
      const res = await fetch("/api/console/triggers");
      if (!res.ok) return;
      const body = (await res.json()) as { triggers: TriggerDto[] };
      setTriggers(body.triggers ?? []);
    } catch {
      // best-effort re-read; the row's own error surface covers action failures
    }
  };

  const act = async (
    method: "PATCH" | "DELETE",
    t: TriggerDto,
    body: Record<string, unknown>,
  ) => {
    setError(null);
    setBusyKey(keyOf(t));
    try {
      const res = await fetch("/api/console/triggers", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? "The action failed.");
        return;
      }
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyKey(null);
    }
  };

  const toggle = async (t: TriggerDto) => {
    const ok = await confirm({
      title: t.enabled ? "Disable this trigger?" : "Enable this trigger?",
      message: t.enabled
        ? `Disabling ${keyOf(t)} stops it firing on future writes until it is re-enabled. Continue?`
        : `Enabling ${keyOf(t)} makes it fire again on matching writes. Continue?`,
      confirmLabel: t.enabled ? "Disable trigger" : "Enable trigger",
    });
    if (!ok) return;
    await act("PATCH", t, {
      schema: t.schema,
      table: t.table,
      name: t.name,
      enabled: !t.enabled,
    });
  };

  const drop = async (t: TriggerDto) => {
    const ok = await confirm({
      title: "Drop this trigger?",
      message: `Permanently drop trigger ${t.name} on ${t.schema}.${t.table}. This cannot be undone. Continue?`,
      confirmLabel: "Drop trigger",
    });
    if (!ok) return;
    await act("DELETE", t, { schema: t.schema, table: t.table, name: t.name });
  };

  const enabledCount = triggers.filter((t) => t.enabled).length;

  const columns: Column<TriggerDto>[] = [
    {
        key: "table",
        header: "table",
        mono: true,
        width: "220px",
        render: (t) => `${t.schema}.${t.table}`,
      },
      { key: "name", header: "trigger", mono: true },
      { key: "timing", header: "timing", width: "110px", render: (t) => parseTiming(t.definition) },
      {
        key: "events",
        header: "events",
        mono: true,
        width: "160px",
        render: (t) => parseEvents(t.definition),
      },
      {
        key: "function",
        header: "function",
        mono: true,
        render: (t) => {
          const fn = parseFunction(t.definition);
          return (
            <span title={t.definition}>
              {fn.length > 48 ? `${fn.slice(0, 47)}…` : fn}
            </span>
          );
        },
      },
      {
        key: "enabled",
        header: "state",
        width: "110px",
        render: (t) =>
          t.enabled ? (
            <Badge tone="var(--ok)">enabled</Badge>
          ) : (
            <Badge>disabled</Badge>
          ),
      },
      {
        key: "actions",
        header: "",
        width: "190px",
        align: "right",
        render: (t) => {
          const busy = busyKey === keyOf(t);
          return (
            <span className="dgrid-toolbar" style={{ justifyContent: "flex-end", padding: 0 }}>
              <Guide id="db-platform.triggers.toggle">
                <button
                  type="button"
                  className="type-chip"
                  disabled={busy}
                  onClick={() => void toggle(t)}
                >
                  {t.enabled ? "Disable" : "Enable"}
                </button>
              </Guide>
              <Guide id="db-platform.triggers.drop">
                <button
                  type="button"
                  className="type-chip"
                  disabled={busy}
                  onClick={() => void drop(t)}
                >
                  Drop
                </button>
              </Guide>
            </span>
          );
        },
      },
  ];

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Triggers" value={triggers.length} accent="var(--data-2)" />
        <StatCard label="Enabled" value={enabledCount} accent="var(--data-3)" />
        <StatCard label="Disabled" value={triggers.length - enabledCount} />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="Triggers"
        title="Table triggers"
        actions={
          <Guide id="db-platform.common.refresh">
            <button type="button" className="type-chip" onClick={() => void refresh()}>
              Refresh
            </button>
          </Guide>
        }
      >
        <Guide id="db-platform.triggers.table">
          <DataTable
            columns={columns}
            rows={triggers}
            getRowKey={keyOf}
            empty="No triggers in the exposed schemas."
            paginate={50}
          />
        </Guide>
      </Section>

      {dialog}
    </div>
  );
}

export default TriggersClient;
