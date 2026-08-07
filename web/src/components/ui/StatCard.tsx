import type { CSSProperties, ReactNode } from "react";
import { Surface } from "../Surface";

/**
 * A single dashboard statistic: an uppercase label, a large figure in the
 * DISPLAY face (the design tokens designate --fd for "big figures"; mono is
 * for inline data/IDs/timestamps, not hero numbers), and an optional hint
 * line. `accent` may only ever be a data-pool token (never --fail; red is
 * reserved for failure).
 */
export function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: string;
}) {
  return (
    <Surface className="stat-card" glint>
      <span className="eyebrow">{label}</span>
      <span
        className="stat-value"
        style={accent ? ({ color: accent } as CSSProperties) : undefined}
      >
        {value}
      </span>
      {hint != null ? <span className="stat-hint">{hint}</span> : null}
    </Surface>
  );
}

export default StatCard;
