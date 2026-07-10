import type { CSSProperties } from "react";

export interface LineChartProps {
  /** Unique id (for the fill gradient). Required — server components can't useId. */
  id: string;
  points: number[];
  /** Stroke color — a data-pool token, never --fail. */
  color?: string;
  height?: number;
  labels?: string[];
  ariaLabel?: string;
}

/**
 * A compact area+line chart in pure SVG (server-renderable). The line keeps a
 * crisp 2px stroke at any width via non-scaling-stroke; the fill is a vertical
 * gradient of the series color, denser at the bottom. The single drop-shadow on
 * the line is the one sanctioned graph shadow in the design language.
 */
export function LineChart({
  id,
  points,
  color = "var(--data-1)",
  height = 120,
  labels,
  ariaLabel,
}: LineChartProps) {
  const W = 300;
  const H = height;
  const padY = 12;
  const n = points.length;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);

  const line = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
    .join(" ");
  const area = `${line} L ${W.toFixed(2)} ${H} L 0 ${H} Z`;
  const gid = `chart-grad-${id}`;

  return (
    <figure className="chart-fig">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        style={{ overflow: "visible" } as CSSProperties}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} stroke="none" />
        <path
          className="chart-line"
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {labels ? (
        <div className="chart-x">
          {labels.map((l, i) => (
            <span key={i} className="mono">
              {l}
            </span>
          ))}
        </div>
      ) : null}
    </figure>
  );
}

export default LineChart;
