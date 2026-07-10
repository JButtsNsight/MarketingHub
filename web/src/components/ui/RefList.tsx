import type { ReactNode } from "react";
import { StatusPill, type StatusKind } from "./StatusPill";

export interface RefRow {
  label: string;
  detail: ReactNode;
  status?: "ok" | "warn" | "info";
}

const STATUS_MAP: Record<
  NonNullable<RefRow["status"]>,
  { kind: StatusKind; label: string }
> = {
  ok: { kind: "ok", label: "OK" },
  warn: { kind: "warn", label: "Note" },
  info: { kind: "idle", label: "Info" },
};

/**
 * A vertical list of reference items — each a label, an optional governed status
 * pill, and a detail line. Used by the architecture-reference surfaces
 * (Overview, Infrastructure, Authentication).
 */
export function RefList({ items }: { items: RefRow[] }) {
  return (
    <ul className="ref-list">
      {items.map((it) => (
        <li className="ref-row" key={it.label}>
          <div className="ref-row-head">
            <span className="ref-row-label">{it.label}</span>
            {it.status ? (
              <StatusPill status={STATUS_MAP[it.status].kind}>
                {STATUS_MAP[it.status].label}
              </StatusPill>
            ) : null}
          </div>
          <p className="ref-row-detail">{it.detail}</p>
        </li>
      ))}
    </ul>
  );
}

export default RefList;
