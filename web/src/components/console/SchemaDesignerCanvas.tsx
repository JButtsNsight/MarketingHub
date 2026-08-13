"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Badge } from "../ui/Badge";
import { Surface } from "../Surface";
import { Guide } from "@/components/guide/Guide";

/**
 * Visual Schema Designer canvas (Studio Database → Schema Visualizer parity).
 *
 * Render-first, READ-ONLY ER diagram: every table is a card (schema.name
 * header + column list with PK/FK badges) and every foreign key is a curved
 * relationship line between the two cards. There is NO on-canvas DDL — this
 * surface never writes, so it needs no confirm modal and no /api calls. All
 * data is introspected server-side (pg-meta listTables + PgColumn +
 * PgRelationship) and handed in as plain props; the client only lays it out
 * and lets you select a table to focus its relationships.
 *
 * Zero new deps: layout is pure arithmetic over the data (no DOM measurement,
 * so it is deterministic and unit-testable), cards are DOM, edges are one SVG
 * layer behind them.
 */

export interface DesignerColumn {
  name: string;
  /** Display type — PostgREST format when present, else the raw pg data_type. */
  dataType: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNullable: boolean;
}

export interface DesignerTable {
  schema: string;
  name: string;
  columns: DesignerColumn[];
  rowsEstimate: number;
}

export interface DesignerEdge {
  /** Foreign-key constraint name — stable, dedup key. */
  id: string;
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
}

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- Layout geometry (exported so tests can assert positions deterministically).
export const CARD_W = 248;
const HEADER_H = 46;
const ROW_H = 26;
const BODY_PAD = 8;
const MAX_VISIBLE_ROWS = 10;
const GAP_X = 84;
const GAP_Y = 56;
const PAD = 28;

/** Rendered height of a card given its column count (body scrolls past the cap). */
export function cardHeight(columnCount: number): number {
  const rows = Math.min(Math.max(columnCount, 1), MAX_VISIBLE_ROWS);
  return HEADER_H + rows * ROW_H + BODY_PAD;
}

/** Stable per-table key: `schema.name`. */
export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/**
 * Deterministic grid layout: tables flow left→right, top→bottom into a
 * roughly-square grid; each grid row is as tall as its tallest card. Returns
 * absolute boxes plus the full canvas size (the wrapper scrolls to it).
 */
export function computeDesignerLayout(tables: DesignerTable[]): {
  positions: Record<string, CardBox>;
  width: number;
  height: number;
} {
  const positions: Record<string, CardBox> = {};
  const n = tables.length;
  if (n === 0) return { positions, width: 0, height: 0 };

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  const rowHeights = new Array<number>(rows).fill(0);
  tables.forEach((t, i) => {
    const r = Math.floor(i / cols);
    const h = cardHeight(t.columns.length);
    if (h > rowHeights[r]) rowHeights[r] = h;
  });

  const rowY = new Array<number>(rows).fill(0);
  let cursor = PAD;
  for (let r = 0; r < rows; r++) {
    rowY[r] = cursor;
    cursor += rowHeights[r] + GAP_Y;
  }

  tables.forEach((t, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    positions[tableKey(t.schema, t.name)] = {
      x: PAD + c * (CARD_W + GAP_X),
      y: rowY[r],
      w: CARD_W,
      h: cardHeight(t.columns.length),
    };
  });

  const width = PAD * 2 + cols * CARD_W + (cols - 1) * GAP_X;
  const height = cursor - GAP_Y + PAD;
  return { positions, width, height };
}

/** Cubic bezier connecting the facing edges of two card boxes. */
export function edgePath(s: CardBox, t: CardBox): string {
  // Self-reference: a small loop off the card's right edge.
  if (s === t) {
    const bx = s.x + s.w;
    const by = s.y + s.h / 2;
    return `M ${bx} ${by - 12} C ${bx + 60} ${by - 46} ${bx + 60} ${by + 46} ${bx} ${by + 12}`;
  }
  const sy = s.y + s.h / 2;
  const ty = t.y + t.h / 2;
  const goRight = t.x + t.w / 2 >= s.x + s.w / 2;
  const sx = goRight ? s.x + s.w : s.x;
  const tx = goRight ? t.x : t.x + t.w;
  const bend = Math.max(48, Math.abs(tx - sx) / 2);
  const c1x = goRight ? sx + bend : sx - bend;
  const c2x = goRight ? tx - bend : tx + bend;
  return `M ${sx} ${sy} C ${c1x} ${sy} ${c2x} ${ty} ${tx} ${ty}`;
}

const SCHEMA_TONES: Record<string, string> = {
  public: "var(--data-1)",
  marketinghub: "var(--data-3)",
  storage: "var(--data-5)",
};
function schemaTone(schema: string, index: number): string {
  return SCHEMA_TONES[schema] ?? `var(--data-${(index % 8) + 1})`;
}

export function SchemaDesignerCanvas({
  tables,
  edges,
}: {
  tables: DesignerTable[];
  edges: DesignerEdge[];
}) {
  const schemas = useMemo(
    () => [...new Set(tables.map((t) => t.schema))].sort(),
    [tables],
  );
  const toneFor = useMemo(() => {
    const m = new Map<string, string>();
    schemas.forEach((s, i) => m.set(s, schemaTone(s, i)));
    return m;
  }, [schemas]);

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);

  const visibleTables = useMemo(
    () => tables.filter((t) => !hidden.has(t.schema)),
    [tables, hidden],
  );
  const visibleKeys = useMemo(
    () => new Set(visibleTables.map((t) => tableKey(t.schema, t.name))),
    [visibleTables],
  );
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          visibleKeys.has(tableKey(e.sourceSchema, e.sourceTable)) &&
          visibleKeys.has(tableKey(e.targetSchema, e.targetTable)),
      ),
    [edges, visibleKeys],
  );

  const { positions, width, height } = useMemo(
    () => computeDesignerLayout(visibleTables),
    [visibleTables],
  );

  // Undirected adjacency for focus highlighting.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set());
      m.get(a)!.add(b);
    };
    for (const e of visibleEdges) {
      const s = tableKey(e.sourceSchema, e.sourceTable);
      const t = tableKey(e.targetSchema, e.targetTable);
      link(s, t);
      link(t, s);
    }
    return m;
  }, [visibleEdges]);

  const isDimmed = (key: string): boolean =>
    selected != null && key !== selected && !neighbors.get(selected)?.has(key);

  const edgeTouchesSelection = (e: DesignerEdge): boolean =>
    selected == null ||
    tableKey(e.sourceSchema, e.sourceTable) === selected ||
    tableKey(e.targetSchema, e.targetTable) === selected;

  const toggleSchema = (schema: string) => {
    setSelected(null);
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  };

  if (tables.length === 0) {
    return (
      <Surface className="empty-state" glint>
        <h2>Nothing to diagram</h2>
        <p>No tables were found in the managed schemas.</p>
      </Surface>
    );
  }

  return (
    <div className="stack">
      <div
        className="chip-row"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
      >
        {schemas.map((schema) => {
          const on = !hidden.has(schema);
          return (
            <Guide key={schema} id="database.designer.schema-chip">
              <button
                type="button"
                className="type-chip"
                aria-pressed={on}
                data-schema={schema}
                onClick={() => toggleSchema(schema)}
                style={{
                  opacity: on ? 1 : 0.45,
                  borderColor: toneFor.get(schema),
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    marginRight: 6,
                    background: toneFor.get(schema),
                    verticalAlign: "middle",
                  }}
                />
                {schema}
              </button>
            </Guide>
          );
        })}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--ink-2)", fontSize: 12 }}>
          {visibleTables.length} tables · {visibleEdges.length} relationships
        </span>
        {selected ? (
          <Guide id="database.designer.clear-focus">
            <button type="button" className="type-chip" onClick={() => setSelected(null)}>
              Clear focus
            </button>
          </Guide>
        ) : null}
      </div>

      <Guide id="database.designer.canvas">
        <Surface className="dtable-wrap" glint>
          <div
            role="group"
            aria-label="Schema diagram"
            style={{ overflow: "auto", maxHeight: "72vh" }}
          >
          <div
            style={{
              position: "relative",
              width: Math.max(width, 320),
              height: Math.max(height, 200),
            }}
          >
            <svg
              width={Math.max(width, 320)}
              height={Math.max(height, 200)}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
              aria-hidden
            >
              <defs>
                <marker
                  id="designer-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L8 4 L0 8 z" fill="var(--data-4)" />
                </marker>
              </defs>
              {visibleEdges.map((e) => {
                const s = positions[tableKey(e.sourceSchema, e.sourceTable)];
                const t = positions[tableKey(e.targetSchema, e.targetTable)];
                if (!s || !t) return null;
                const active = edgeTouchesSelection(e);
                return (
                  <path
                    key={e.id}
                    data-edge-id={e.id}
                    data-active={active ? "true" : "false"}
                    d={edgePath(s, t)}
                    fill="none"
                    stroke={active ? "var(--data-4)" : "var(--hair)"}
                    strokeWidth={active && selected ? 2 : 1.4}
                    strokeOpacity={active ? 0.9 : 0.2}
                    markerEnd="url(#designer-arrow)"
                  />
                );
              })}
            </svg>

            {visibleTables.map((t) => {
              const key = tableKey(t.schema, t.name);
              const box = positions[key];
              if (!box) return null;
              const dim = isDimmed(key);
              const focused = selected === key;
              const tone = toneFor.get(t.schema) ?? "var(--data-1)";
              const cardStyle: CSSProperties = {
                position: "absolute",
                left: box.x,
                top: box.y,
                width: box.w,
                // Nodes FLOAT over the edge layer — the surface must be opaque
                // (no backdrop-filter exists to rescue a translucent tint) and
                // gets the slight per-theme float shadow.
                background: "var(--surface-solid)",
                color: "var(--ink)",
                border: `1px solid ${focused ? tone : "var(--hair)"}`,
                borderRadius: 10,
                overflow: "hidden",
                textAlign: "left",
                padding: 0,
                cursor: "pointer",
                opacity: dim ? 0.32 : 1,
                boxShadow: focused
                  ? `0 0 0 2px ${tone}, var(--shadow-float)`
                  : "var(--shadow-float)",
                transition: "opacity 120ms ease, box-shadow 120ms ease",
              };
              return (
                <Guide key={key} id="database.designer.table-card">
                  <button
                    type="button"
                    className="designer-card"
                    data-table-key={key}
                    data-dim={dim ? "true" : "false"}
                    aria-pressed={focused}
                    title={`${key} · ${t.rowsEstimate.toLocaleString()} rows`}
                    onClick={() => setSelected((cur) => (cur === key ? null : key))}
                    style={cardStyle}
                  >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--hair)",
                      borderLeft: `3px solid ${tone}`,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <span
                        className="eyebrow"
                        style={{ display: "block", color: "var(--ink-2)" }}
                      >
                        {t.schema}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {t.name}
                      </span>
                    </div>
                  </div>
                  <div
                    style={{
                      maxHeight: MAX_VISIBLE_ROWS * ROW_H,
                      overflowY: "auto",
                      padding: "4px 0",
                    }}
                  >
                    {t.columns.map((c) => (
                      <div
                        key={c.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          height: ROW_H,
                          padding: "0 10px",
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            fontWeight: c.isPrimaryKey ? 600 : 400,
                          }}
                          title={`${c.name} ${c.dataType}${c.isNullable ? "" : " NOT NULL"}`}
                        >
                          {c.name}
                        </span>
                        {c.isPrimaryKey ? <Badge tone="var(--data-1)">PK</Badge> : null}
                        {c.isForeignKey ? <Badge tone="var(--data-4)">FK</Badge> : null}
                        <span
                          className="mono"
                          style={{
                            color: "var(--ink-2)",
                            fontSize: 11,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.dataType}
                        </span>
                      </div>
                    ))}
                  </div>
                  </button>
                </Guide>
              );
            })}
          </div>
          </div>
        </Surface>
      </Guide>
    </div>
  );
}

export default SchemaDesignerCanvas;
