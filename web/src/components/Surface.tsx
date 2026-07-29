import type { ElementType, ReactNode } from "react";

type SurfaceOwnProps = {
  /** Element to render as. Defaults to a <div>. */
  as?: ElementType;
  /** Add the refraction glint sheen — large surfaces only (panels, cards, modals, tables). */
  glint?: boolean;
  /** Whether this reads as an elevated surface. Reflected as data-elevated. */
  elevated?: boolean;
  className?: string;
  children?: ReactNode;
};

// deno-lint-ignore no-explicit-any
type SurfaceProps = SurfaceOwnProps & Record<string, unknown>;

/**
 * The `.surface` primitive from the NSight design language. It consumes only the
 * `--surface-*` tokens (flat, resolved per light/dark theme). It never applies a
 * backdrop-filter — the page gradient reads through the transparent surface.
 */
export function Surface({
  as,
  glint = false,
  elevated = true,
  className,
  children,
  ...rest
}: SurfaceProps) {
  const Tag = (as ?? "div") as ElementType;
  const classes = ["surface", glint ? "glint" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={classes} data-elevated={elevated ? "true" : "false"} {...rest}>
      {children}
    </Tag>
  );
}

export default Surface;
