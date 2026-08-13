"use client";

import { useState } from "react";
import { Guide } from "@/components/guide/Guide";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Surface } from "../Surface";
import { useConfirm, type ConfirmOptions } from "../ui/AlertDialog";

/**
 * Publications (Studio → Database → Publications): browse every logical-
 * replication publication with its owner, scope (all-tables vs a chosen set),
 * published operations, and member tables. Create / alter / drop all flow
 * through the group-gated /api/console/publications routes.
 *
 * Every mutation is DDL, so each one goes behind the interrupting confirm modal
 * (useConfirm) — the guard sits on the write, never on browsing.
 */

export interface PublicationDto {
  name: string;
  owner: string;
  allTables: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  /** -1 means "all tables". */
  tableCount: number;
  /** Member tables ("schema.table") for a non-all-tables publication. */
  tables: string[];
}

export interface TableRefDto {
  schema: string;
  name: string;
}

interface PublishFlags {
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

const PUBLISH_OPS: Array<{ key: keyof PublishFlags; label: string }> = [
  { key: "insert", label: "insert" },
  { key: "update", label: "update" },
  { key: "delete", label: "delete" },
  { key: "truncate", label: "truncate" },
];

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function opBadges(pub: PublicationDto) {
  const active = PUBLISH_OPS.filter((o) => pub[o.key]);
  if (active.length === 0) return <span className="mono">—</span>;
  return (
    <span className="campaign-actions">
      {active.map((o) => (
        <Badge key={o.key} tone="var(--data-2)">
          {o.label}
        </Badge>
      ))}
    </span>
  );
}

function tablesCell(pub: PublicationDto) {
  if (pub.allTables) return <Badge tone="var(--warn)">all tables</Badge>;
  if (pub.tables.length === 0) return <span className="mono">— none</span>;
  const text = pub.tables.join(", ");
  return (
    <span className="mono" title={text}>
      {text.length > 64 ? `${text.slice(0, 63)}…` : text}
    </span>
  );
}

export function PublicationsClient({
  initialPublications,
  availableTables,
}: {
  initialPublications: PublicationDto[];
  availableTables: TableRefDto[];
}) {
  const [publications, setPublications] = useState(initialPublications);
  const [error, setError] = useState<string | null>(null);
  // The two panels are mutually exclusive but tracked independently so a
  // publication literally named "new" can never collide with the create panel.
  const [creating, setCreating] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const closePanels = () => {
    setCreating(false);
    setEditingName(null);
  };

  const reload = async () => {
    try {
      const res = await fetch("/api/console/publications");
      if (!res.ok) return;
      const body = (await res.json()) as { publications?: PublicationDto[] };
      setPublications(body.publications ?? []);
    } catch {
      // best-effort refresh; the panel/table keep the last good state
    }
  };

  const drop = async (pub: PublicationDto) => {
    const ok = await confirm({
      title: `Drop publication ${pub.name}?`,
      message: (
        <>
          This permanently removes the <strong>{pub.name}</strong> publication.
          Any logical-replication subscriber reading from it stops receiving
          changes. This cannot be undone.
        </>
      ),
      confirmLabel: "Drop publication",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch("/api/console/publications", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: pub.name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Drop failed.");
        return;
      }
      await reload();
    } catch {
      setError("Network error — please try again.");
    }
  };

  const editing = editingName
    ? (publications.find((p) => p.name === editingName) ?? null)
    : null;

  const columns: Column<PublicationDto>[] = [
    { key: "name", header: "publication", mono: true },
    { key: "owner", header: "owner", mono: true, width: "150px" },
    {
      key: "scope",
      header: "scope",
      width: "120px",
      render: (p) =>
        p.allTables ? (
          <Badge tone="var(--warn)">all tables</Badge>
        ) : (
          <Badge>{`${p.tableCount} table${p.tableCount === 1 ? "" : "s"}`}</Badge>
        ),
    },
    { key: "operations", header: "operations", render: opBadges },
    { key: "tables", header: "member tables", render: tablesCell },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "170px",
      render: (p) => (
        <span className="campaign-actions">
          <Guide id="db-platform.publications.edit">
            <button
              type="button"
              className="type-chip"
              onClick={() => {
                setCreating(false);
                setEditingName(editingName === p.name ? null : p.name);
              }}
            >
              {editingName === p.name ? "Close" : "Edit"}
            </button>
          </Guide>
          <Guide id="db-platform.publications.drop">
            <button type="button" className="type-chip" onClick={() => void drop(p)}>
              Drop
            </button>
          </Guide>
        </span>
      ),
    },
  ];

  const allTablesCount = publications.filter((p) => p.allTables).length;

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Publications" value={publications.length} accent="var(--data-2)" />
        <StatCard
          label="All-tables"
          value={allTablesCount}
          hint={allTablesCount > 0 ? "stream every table" : "all scoped"}
          accent="var(--data-3)"
        />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {creating ? (
        <PublicationForm
          key="new"
          mode="create"
          availableTables={availableTables}
          confirm={confirm}
          onDone={(changed) => {
            closePanels();
            if (changed) void reload();
          }}
        />
      ) : null}

      {editing ? (
        <PublicationForm
          key={editing.name}
          mode="alter"
          target={editing}
          availableTables={availableTables}
          confirm={confirm}
          onDone={(changed) => {
            closePanels();
            if (changed) void reload();
          }}
        />
      ) : null}

      <Section
        eyebrow="Logical replication"
        title="Publications"
        actions={
          <Guide id="db-platform.publications.create">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setEditingName(null);
                setCreating((v) => !v);
              }}
            >
              {creating ? "Close" : "New publication"}
            </button>
          </Guide>
        }
      >
        <Guide id="db-platform.publications.table">
          <DataTable
            columns={columns}
            rows={publications}
            getRowKey={(p) => p.name}
            empty="No publications."
            paginate={50}
          />
        </Guide>
      </Section>
      {dialog}
    </div>
  );
}

/**
 * Create/alter form. Name + scope are editable only when creating; altering a
 * publication changes its published operations and (for a table-scoped
 * publication) its member-table set. Submitting opens the confirm modal — the
 * DDL guard — before anything is sent.
 */
function PublicationForm({
  mode,
  target,
  availableTables,
  confirm,
  onDone,
}: {
  mode: "create" | "alter";
  target?: PublicationDto;
  availableTables: TableRefDto[];
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onDone: (changed: boolean) => void;
}) {
  const [name, setName] = useState(target?.name ?? "");
  const [allTables, setAllTables] = useState(target?.allTables ?? false);
  const [publish, setPublish] = useState<PublishFlags>({
    insert: target?.insert ?? true,
    update: target?.update ?? true,
    delete: target?.delete ?? true,
    truncate: target?.truncate ?? true,
  });
  const [selected, setSelected] = useState<Set<string>>(
    new Set(target && !target.allTables ? target.tables : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Altering an all-tables publication can only change its published ops.
  const tablePickerVisible = mode === "create" ? !allTables : !target?.allTables;

  const toggleTable = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = async () => {
    setError(null);
    if (mode === "create" && !IDENTIFIER_RE.test(name)) {
      setError(
        "Enter a valid name: a letter or underscore, then letters, digits or underscores.",
      );
      return;
    }
    if (!PUBLISH_OPS.some((o) => publish[o.key])) {
      setError("Select at least one operation to publish.");
      return;
    }
    const tables = tablePickerVisible
      ? [...selected].map((key) => {
          const dot = key.indexOf(".");
          return { schema: key.slice(0, dot), table: key.slice(dot + 1) };
        })
      : [];

    const ok = await confirm({
      title: mode === "create" ? `Create publication ${name}?` : `Alter publication ${name}?`,
      message:
        mode === "create" ? (
          <>
            Create a logical-replication publication <strong>{name}</strong>{" "}
            {allTables ? "for ALL tables" : `for ${tables.length} table(s)`}.
            Subscribers can immediately begin streaming the selected changes.
          </>
        ) : (
          <>
            Apply changes to <strong>{name}</strong>. This alters what
            logical-replication subscribers receive.
          </>
        ),
      confirmLabel: mode === "create" ? "Create publication" : "Save changes",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const body =
        mode === "create"
          ? { name, allTables, tables, publish }
          : {
              name,
              publish,
              // Only send tables for a table-scoped publication; a non-empty set
              // replaces membership, an empty set leaves it untouched.
              ...(tablePickerVisible && tables.length > 0 ? { tables } : {}),
            };
      const res = await fetch("/api/console/publications", {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(parsed?.error ?? "Request failed.");
        setBusy(false);
        return;
      }
      onDone(true);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">
        {mode === "create" ? "New publication" : `Alter ${name}`}
      </span>

      <Guide id="db-platform.publications.name-field">
        <div className="field">
          <label htmlFor="pub-name">name</label>
          <input
            id="pub-name"
            className="surface control mono"
            type="text"
            placeholder="publication_name"
            value={name}
            disabled={mode === "alter"}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </Guide>

      {mode === "create" ? (
        <Guide id="db-platform.publications.all-tables">
          <label className="teditor-null">
            <input
              type="checkbox"
              checked={allTables}
              onChange={(e) => setAllTables(e.target.checked)}
            />{" "}
            Publish ALL tables in the database
          </label>
        </Guide>
      ) : null}

      <Guide id="db-platform.publications.operations">
        <div className="field">
          <label>published operations</label>
          <div className="campaign-actions">
            {PUBLISH_OPS.map((o) => (
              <label key={o.key} className="teditor-null">
                <input
                  type="checkbox"
                  checked={publish[o.key]}
                  onChange={(e) => setPublish({ ...publish, [o.key]: e.target.checked })}
                />{" "}
                {o.label}
              </label>
            ))}
          </div>
        </div>
      </Guide>

      {tablePickerVisible ? (
        <Guide id="db-platform.publications.member-tables">
          <div className="field">
            <label>member tables</label>
            <div className="pub-table-picker">
              {availableTables.length === 0 ? (
                <span className="teditor-test">No tables available.</span>
              ) : (
                availableTables.map((t) => {
                  const key = `${t.schema}.${t.name}`;
                  return (
                    <label key={key} className="teditor-null">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => toggleTable(key)}
                      />{" "}
                      <span className="mono">{key}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </Guide>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          className="type-chip"
          onClick={() => onDone(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <Guide id="db-platform.publications.submit">
          <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
            {mode === "create" ? "Create publication" : "Save changes"}
          </button>
        </Guide>
      </div>
    </Surface>
  );
}

export default PublicationsClient;
