"use client";

import { useMemo, useState } from "react";

import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Surface } from "../Surface";
import type {
  ApiDocColumn,
  ApiDocEntry,
} from "@/lib/console/apidocs";

/**
 * Data API reference (Studio "API Docs" parity). A read-only surface: it takes
 * per-table examples already generated on the server from live introspection
 * and lets you switch table and language. Nothing here writes — there is no
 * confirm gate because there is no mutation; the snippets are copy-paste
 * templates, not executed against the live host.
 *
 * The service-role key is server-only; every example prints `$SUPABASE_*` env
 * placeholders rather than any real secret.
 */

type Lang = "curl" | "js" | "graphql";

const LANGS: { id: Lang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "js", label: "JavaScript" },
  { id: "graphql", label: "GraphQL" },
];

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

const COLUMN_DEFS: Column<ApiDocColumn>[] = [
  {
    key: "name",
    header: "column",
    mono: true,
    render: (c) => (
      <span>
        {c.name}
        {c.isPrimaryKey ? (
          <>
            {" "}
            <Badge tone="var(--data-3)" title="primary key">
              pk
            </Badge>
          </>
        ) : null}
      </span>
    ),
  },
  {
    key: "format",
    header: "type",
    width: "22%",
    render: (c) => (
      <Badge tone="var(--data-2)" title={c.dataType}>
        {c.format}
      </Badge>
    ),
  },
  {
    key: "isNullable",
    header: "nullable",
    width: "110px",
    render: (c) => (c.isNullable ? <Badge>nullable</Badge> : <Badge>required</Badge>),
  },
  {
    key: "defaultValue",
    header: "default",
    mono: true,
    width: "20%",
    render: (c) => {
      const text = c.defaultValue ?? "—";
      return (
        <span title={text}>{text.length > 28 ? `${text.slice(0, 27)}…` : text}</span>
      );
    },
  },
  {
    key: "comment",
    header: "description",
    render: (c) => c.comment ?? "—",
  },
];

export function ApiDocsClient({ entries }: { entries: ApiDocEntry[] }) {
  const [selectedKey, setSelectedKey] = useState<string>(() =>
    entries.length ? tableKey(entries[0].table.schema, entries[0].table.name) : "",
  );
  const [lang, setLang] = useState<Lang>("curl");

  const entry = useMemo(
    () =>
      entries.find(
        (e) => tableKey(e.table.schema, e.table.name) === selectedKey,
      ) ?? entries[0],
    [entries, selectedKey],
  );

  if (!entry) {
    return (
      <Surface className="empty-state" glint>
        <h2>No tables to document</h2>
        <p>No tables were found in the API-exposed schemas.</p>
      </Surface>
    );
  }

  const { table, snippets } = entry;
  const isPublic = table.schema === "public";
  const schemaLabel = isPublic ? "public (default)" : table.schema;

  return (
    <div className="stack">
      <Surface className="dgrid-toolbar">
        <div className="field">
          <label htmlFor="apidocs-table">Table</label>
          <select
            id="apidocs-table"
            className="surface control"
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
          >
            {entries.map((e) => {
              const key = tableKey(e.table.schema, e.table.name);
              return (
                <option key={key} value={key}>
                  {key}
                </option>
              );
            })}
          </select>
        </div>
        <span className="spacer" />
        <div style={{ display: "flex", gap: 8 }}>
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={lang === l.id ? "type-chip on" : "type-chip"}
              aria-pressed={lang === l.id}
              onClick={() => setLang(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Surface>

      <div className="stat-grid">
        <StatCard label="Schema" value={schemaLabel} accent="var(--data-2)" />
        <StatCard label="Columns" value={table.columns.length} accent="var(--data-3)" />
        <StatCard
          label="Primary key"
          value={table.primaryKeys.length ? table.primaryKeys.join(", ") : "none"}
          hint={table.primaryKeys.length ? undefined : "no single-row update path"}
        />
      </div>

      <Section eyebrow="Schema" title={`${table.schema}.${table.name}`}>
        {table.comment ? (
          <p className="ref-note">
            <Badge>note</Badge>
            <span>{table.comment}</span>
          </p>
        ) : null}
        <DataTable
          columns={COLUMN_DEFS}
          rows={table.columns}
          getRowKey={(c) => c.name}
          empty="This table has no columns."
        />
      </Section>

      {lang === "curl" ? (
        <Section
          eyebrow="PostgREST"
          title="rest/v1"
          description={
            isPublic
              ? undefined
              : "This schema is selected with Accept-Profile (reads) / Content-Profile (writes)."
          }
        >
          <div className="stack">
            <CodeBlock label="GET — read rows" code={snippets.restSelect} />
            <CodeBlock label="POST — insert" code={snippets.restInsert} />
            <CodeBlock label="PATCH — update" code={snippets.restUpdate} />
            <CodeBlock label="DELETE — delete" code={snippets.restDelete} />
          </div>
        </Section>
      ) : null}

      {lang === "js" ? (
        <Section
          eyebrow="supabase-js"
          title="Client library"
          description={
            isPublic
              ? "The service-role client runs server-side only."
              : ".schema() selects this schema; the service-role client runs server-side only."
          }
        >
          <div className="stack">
            <CodeBlock label="select" code={snippets.jsSelect} />
            <CodeBlock label="insert" code={snippets.jsInsert} />
            <CodeBlock label="update" code={snippets.jsUpdate} />
            <CodeBlock label="delete" code={snippets.jsDelete} />
          </div>
        </Section>
      ) : null}

      {lang === "graphql" ? (
        <Section
          eyebrow="pg_graphql"
          title="graphql/v1"
          description="pg_graphql exposes each table as a Collection with Relay-style edges/node."
        >
          <CodeBlock label="query" code={snippets.graphql} />
        </Section>
      ) : null}
    </div>
  );
}

export default ApiDocsClient;
