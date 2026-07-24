import type { CSSProperties, ReactNode } from "react";

/**
 * A small neutral label chip. Pass `tone` (a data-pool token, e.g.
 * `var(--data-3)`) to tint it; otherwise it renders as a hairline-bordered
 * neutral badge. Uppercase, mono-adjacent — used for types, kinds, flags.
 */
export function Badge({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <span
      className={tone ? "badge badge-tone" : "badge"}
      title={title}
      style={tone ? ({ "--chip": tone } as CSSProperties) : undefined}
    >
      {children}
    </span>
  );
}

export default Badge;
