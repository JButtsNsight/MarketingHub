"use client";

import { useState } from "react";
import { DataTable, type Column } from "../ui/DataTable";
import { Badge } from "../ui/Badge";
import { Section } from "../ui/Section";
import { Surface } from "../Surface";
import { useConfirm } from "../ui/AlertDialog";

/**
 * Enumerated Types island (Studio parity). Live enum types come from the
 * server page via pg-meta introspection; this client owns the three DDL
 * actions — create type, add value, drop type — all routed through the group-
 * gated /api/console/types verbs. Every write is DDL, so every write is
 * interrupted by the confirm modal (controls-match-risk: guard the write, not
 * the browse). `ADD VALUE` is called out as irreversible.
 */

export interface EnumTypeDto {
  schema: string;
  name: string;
  values: string[];
}

const keyOf = (t: EnumTypeDto): string => `${t.schema}.${t.name}`;

export function TypesClient({
  initialTypes,
  schemas,
}: {
  initialTypes: EnumTypeDto[];
  schemas: string[];
}) {
  const [types, setTypes] = useState(initialTypes);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  // Create-type form.
  const [createOpen, setCreateOpen] = useState(false);
  const [newSchema, setNewSchema] = useState(schemas[0] ?? "public");
  const [newName, setNewName] = useState("");
  const [newValues, setNewValues] = useState<string[]>([]);
  const [newValueDraft, setNewValueDraft] = useState("");

  // Inline add-value editor (keyed by schema.name).
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");

  const refresh = async () => {
    try {
      const res = await fetch("/api/console/types");
      if (!res.ok) return;
      const body = (await res.json()) as { types: EnumTypeDto[] };
      setTypes(body.types);
    } catch {
      // list refresh is best-effort; the panel keeps its own error surface
    }
  };

  const readError = async (res: Response, fallback: string): Promise<string> => {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? fallback;
  };

  const stageDraftValue = () => {
    const v = newValueDraft.trim();
    if (!v || newValues.includes(v)) return;
    setNewValues([...newValues, v]);
    setNewValueDraft("");
  };

  const resetCreate = () => {
    setCreateOpen(false);
    setNewName("");
    setNewValues([]);
    setNewValueDraft("");
  };

  const createType = async () => {
    const name = newName.trim();
    if (!name || newValues.length === 0 || busy) return;
    const ok = await confirm({
      title: "Create enum type?",
      message: `This runs CREATE TYPE ${newSchema}.${name} AS ENUM (${newValues.length} value${newValues.length === 1 ? "" : "s"}) as superuser.`,
      confirmLabel: "Create type",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: newSchema, name, values: newValues }),
      });
      if (!res.ok) {
        setError(await readError(res, "Creating the type failed."));
        return;
      }
      resetCreate();
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const addValue = async (t: EnumTypeDto, raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    const ok = await confirm({
      title: `Add value to ${t.schema}.${t.name}?`,
      message: `ALTER TYPE … ADD VALUE is irreversible — a label can never be removed once added. Add “${value}” to ${t.schema}.${t.name}?`,
      confirmLabel: "Add value",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/types", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: t.schema, name: t.name, value }),
      });
      if (!res.ok) {
        setError(await readError(res, "Adding the value failed."));
        return;
      }
      setAddingKey(null);
      setAddDraft("");
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const dropType = async (t: EnumTypeDto) => {
    if (busy) return;
    const ok = await confirm({
      title: `Drop ${t.schema}.${t.name}?`,
      message: `DROP TYPE ${t.schema}.${t.name} is permanent and will fail if any column still uses it. Continue?`,
      confirmLabel: "Drop type",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/types", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: t.schema, name: t.name }),
      });
      if (!res.ok) {
        setError(await readError(res, "Dropping the type failed."));
        return;
      }
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<EnumTypeDto>[] = [
    {
      key: "name",
      header: "type",
      mono: true,
      width: "260px",
      render: (t) => `${t.schema}.${t.name}`,
    },
    {
      key: "values",
      header: "values",
      render: (t) => (
        <span className="type-values">
          {t.values.map((v) => (
            <Badge key={v} tone="var(--data-2)">
              {v}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      width: "300px",
      align: "right",
      render: (t) => {
        const k = keyOf(t);
        if (addingKey === k) {
          return (
            <span className="dgrid-toolbar">
              <input
                className="surface control teditor-fctl"
                aria-label={`New value for ${k}`}
                type="text"
                placeholder="new value"
                value={addDraft}
                onChange={(e) => setAddDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addValue(t, addDraft);
                  }
                }}
              />
              <button
                type="button"
                className="type-chip"
                disabled={busy || !addDraft.trim()}
                onClick={() => void addValue(t, addDraft)}
              >
                Add
              </button>
              <button
                type="button"
                className="type-chip"
                onClick={() => {
                  setAddingKey(null);
                  setAddDraft("");
                }}
              >
                Cancel
              </button>
            </span>
          );
        }
        return (
          <span className="dgrid-toolbar">
            <button
              type="button"
              className="type-chip"
              onClick={() => {
                setAddingKey(k);
                setAddDraft("");
              }}
            >
              Add value
            </button>
            <button
              type="button"
              className="type-chip"
              disabled={busy}
              onClick={() => void dropType(t)}
            >
              Drop
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="stack">
      {error ? (
        <p className="form-error mono" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="Postgres"
        title="Enumerated types"
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setCreateOpen((v) => !v)}
          >
            {createOpen ? "Close" : "New type"}
          </button>
        }
      >
        {createOpen ? (
          <Surface className="teditor-insert" elevated={false}>
            <span className="eyebrow">New enum type</span>
            <div className="dgrid-toolbar">
              <select
                className="surface control teditor-fctl"
                aria-label="Schema"
                value={newSchema}
                onChange={(e) => setNewSchema(e.target.value)}
              >
                {schemas.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                className="surface control teditor-fctl mono"
                aria-label="Type name"
                type="text"
                placeholder="type name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="dgrid-toolbar">
              <input
                className="surface control teditor-fctl"
                aria-label="Add enum value"
                type="text"
                placeholder="value"
                value={newValueDraft}
                onChange={(e) => setNewValueDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    stageDraftValue();
                  }
                }}
              />
              <button type="button" className="type-chip" onClick={stageDraftValue}>
                Add value
              </button>
              {newValues.map((v, i) => (
                <button
                  key={`${v}-${i}`}
                  type="button"
                  className="type-chip on"
                  title="Remove value"
                  onClick={() => setNewValues(newValues.filter((_, j) => j !== i))}
                >
                  {v} ✕
                </button>
              ))}
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="type-chip"
                onClick={resetCreate}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void createType()}
                disabled={busy || !newName.trim() || newValues.length === 0}
              >
                Create type
              </button>
            </div>
          </Surface>
        ) : null}

        <DataTable
          columns={columns}
          rows={types}
          getRowKey={keyOf}
          empty="No enum types in the surfaced schemas."
          paginate={50}
        />
      </Section>

      {dialog}
    </div>
  );
}

export default TypesClient;
