import Link from "next/link";
import type { CSSProperties } from "react";
import type { Template } from "@/lib/templates/schema";
import { Surface } from "../Surface";
import { categoryColorVar } from "./categoryColor";
import { Guide } from "@/components/guide/Guide";

/** ISO timestamp → deterministic YYYY-MM-DD (mono, locale-independent). */
function isoDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * A single template in the browse grid. Name in the display face (Geist medium),
 * a position-colored category chip (from the data pool — never red), tag chips,
 * a type badge, and the created date in IBM Plex Mono. Built on `.surface`.
 */
export function TemplateCard({ template }: { template: Template }) {
  const chipStyle = { "--chip": categoryColorVar(template.category) } as CSSProperties;

  return (
    <Surface as="article" className="tpl-card" glint>
      <Guide id="engagement.templates.card">
        <Link className="tpl-card-link" href={`/templates/${template.id}`}>
          <span className="tpl-name">{template.name}</span>
        </Link>
      </Guide>

      <div className="tpl-meta">
        <span className="tpl-category chip" style={chipStyle}>
          {template.category}
        </span>
        <span className="tpl-type-badge">
          {template.type === "email" ? "Email" : "Text"}
        </span>
      </div>

      {template.tags.length > 0 && (
        <ul className="tpl-tags">
          {template.tags.map((t) => (
            <li key={t} className="tpl-tag">
              {t}
            </li>
          ))}
        </ul>
      )}

      <time className="tpl-date mono" dateTime={template.created_at}>
        {isoDate(template.created_at)}
      </time>
    </Surface>
  );
}

export default TemplateCard;
