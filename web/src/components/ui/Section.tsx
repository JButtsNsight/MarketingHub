import type { ReactNode } from "react";
import { Surface } from "../Surface";

/**
 * A titled content panel built on the .surface primitive. Optional eyebrow /
 * title / description header with a right-aligned actions slot. Large surface,
 * so it carries the glint by default.
 */
export function Section({
  title,
  eyebrow,
  description,
  actions,
  children,
  glint = true,
}: {
  title?: ReactNode;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  glint?: boolean;
}) {
  const hasHead = title != null || eyebrow != null || actions != null;
  return (
    <Surface as="section" className="panel" glint={glint}>
      {hasHead ? (
        <div className="panel-head">
          <div className="panel-head-text">
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            {title ? <h2>{title}</h2> : null}
            {description ? <p className="panel-desc">{description}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Surface>
  );
}

export default Section;
