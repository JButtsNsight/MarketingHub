import type { Template } from "@/lib/templates/schema";
import { TemplateCard } from "./TemplateCard";

/** Responsive grid of template cards. */
export function TemplateGrid({ templates }: { templates: Template[] }) {
  return (
    <div className="tpl-grid">
      {templates.map((t) => (
        <TemplateCard key={t.id} template={t} />
      ))}
    </div>
  );
}

export default TemplateGrid;
