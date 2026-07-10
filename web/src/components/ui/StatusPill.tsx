import type { CSSProperties, ReactNode } from "react";

/**
 * Status meaning is governed: ok / run / warn / fail / idle map to the status
 * tokens, and RED (--fail) is reserved exclusively for failure/alert. A small
 * filled dot plus a label, tinted from the resolved --status token.
 */
export type StatusKind = "ok" | "run" | "warn" | "fail" | "idle";

const STATUS_TOKEN: Record<StatusKind, string> = {
  ok: "var(--ok)",
  run: "var(--run)",
  warn: "var(--warn)",
  fail: "var(--fail)",
  idle: "var(--idle)",
};

export function StatusPill({
  status,
  children,
}: {
  status: StatusKind;
  children: ReactNode;
}) {
  return (
    <span
      className="status-pill"
      data-status={status}
      style={{ "--status": STATUS_TOKEN[status] } as CSSProperties}
    >
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export default StatusPill;
