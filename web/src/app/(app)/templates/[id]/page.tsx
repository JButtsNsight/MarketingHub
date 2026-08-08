import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { getTemplate } from "@/lib/templates/repo";
import { TemplatePreview } from "@/components/templates/TemplatePreview";
import { TemplateEditor } from "@/components/templates/TemplateEditor";
import { categoryColorVar } from "@/components/templates/categoryColor";
import { Surface } from "@/components/Surface";

export const dynamic = "force-dynamic";

/** ISO timestamp → deterministic YYYY-MM-DD (mono, locale-independent). */
function isoDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Single-template view. Server component: it loads the (server-only) repo row
 * and 404s via `notFound()` for an unknown id. Renders the type-appropriate
 * preview alongside a metadata sidebar (category, tags, owner, timestamps).
 */
export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't be
  // viewed by an authenticated employee outside the `marketing` Cognito group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const { id } = await params;
  const template = await getTemplate(id, db);
  if (!template) notFound();

  const chipStyle = {
    "--chip": categoryColorVar(template.category),
  } as CSSProperties;

  return (
    <article className="tpl-detail">
      <div className="page-head">
        <h1>{template.name}</h1>
        <Link className="type-chip" href="/templates">
          Back to templates
        </Link>
      </div>

      <div className="tpl-detail-body">
        <div className="tpl-detail-preview">
          <TemplatePreview template={template} />
          <TemplateEditor key={template.updated_at} template={template} />
        </div>

        <Surface as="aside" className="tpl-detail-meta" glint>
          <h2>Details</h2>
          <dl>
            <dt>Type</dt>
            <dd>{template.type === "email" ? "Email" : "Text"}</dd>

            <dt>Category</dt>
            <dd>
              <span className="chip" style={chipStyle}>
                {template.category}
              </span>
            </dd>

            <dt>Tags</dt>
            <dd>
              {template.tags.length > 0 ? (
                <ul className="tpl-tags">
                  {template.tags.map((t) => (
                    <li key={t} className="tpl-tag">
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">None</span>
              )}
            </dd>

            <dt>Owner</dt>
            <dd className="mono">{template.created_by}</dd>

            <dt>Created</dt>
            <dd>
              <time className="mono" dateTime={template.created_at}>
                {isoDate(template.created_at)}
              </time>
            </dd>

            <dt>Updated</dt>
            <dd>
              <time className="mono" dateTime={template.updated_at}>
                {isoDate(template.updated_at)}
              </time>
            </dd>
          </dl>
        </Surface>
      </div>
    </article>
  );
}
