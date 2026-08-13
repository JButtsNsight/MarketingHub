import type { Template } from "@/lib/templates/schema";
import { TemplateCard } from "./TemplateCard";
import { Guide } from "@/components/guide/Guide";

/** Responsive grid of template cards. */
export function TemplateGrid({ templates }: { templates: Template[] }) {
  return (
    <Guide id="engagement.templates.grid">
      <div className="tpl-grid">
        {templates.map((t) => (
          <TemplateCard key={t.id} template={t} />
        ))}
      </div>
    </Guide>
  );
}

export default TemplateGrid;
