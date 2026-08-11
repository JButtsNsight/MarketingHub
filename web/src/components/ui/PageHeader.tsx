import type { ReactNode } from "react";

/**
 * Console page header: an optional uppercase eyebrow, the page title (Geist
 * 600 via the h1 rule), an optional subtitle, and a right-aligned slot for a count
 * (mono) and/or action controls. Purely presentational — safe in server
 * components.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  count,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
}) {
  const hasRight = count != null || actions != null;
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-header-sub">{subtitle}</p> : null}
      </div>
      {hasRight ? (
        <div className="page-header-right">
          {count != null ? <span className="count mono">{count}</span> : null}
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export default PageHeader;
