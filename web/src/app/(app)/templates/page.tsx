import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { searchTemplates } from "@/lib/templates/repo";
import { TEMPLATE_TYPES, type TemplateType } from "@/lib/templates/schema";
import { SearchBar } from "@/components/templates/SearchBar";
import { FilterChips } from "@/components/templates/FilterChips";
import { TemplateGrid } from "@/components/templates/TemplateGrid";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Templates · MarketingHub",
};

type RawParams = Record<string, string | string[] | undefined>;

/** First value of a possibly-array searchParam, trimmed to a string. */
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function coerceType(value: string): TemplateType | undefined {
  return (TEMPLATE_TYPES as readonly string[]).includes(value)
    ? (value as TemplateType)
    : undefined;
}

/**
 * Browse / search / filter page. Server component: it reads `q/category/type`
 * from the URL, queries the (server-only) repo, and renders the results grid or
 * an empty state. `searchTemplates` degrades to a plain list when `q` is blank.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't be
  // browsed by an authenticated employee outside the `marketing` Cognito group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const params = await searchParams;
  const q = one(params.q);
  const category = one(params.category) || undefined;
  const type = coerceType(one(params.type));

  const templates = await searchTemplates(q, { category, type }, db);
  const filtered = Boolean(q || category || type);

  return (
    <section className="templates-page">
      <div className="page-head">
        <Guide id="engagement.templates.heading">
          <h1>Templates</h1>
        </Guide>
        <div className="page-head-right">
          <span className="count mono">
            {templates.length}{" "}
            {filtered
              ? templates.length === 1
                ? "result"
                : "results"
              : "total"}
          </span>
          <Guide id="engagement.templates.upload">
            <Link className="btn-primary" href="/templates/new">
              Upload
            </Link>
          </Guide>
        </div>
      </div>

      <div className="templates-toolbar">
        <SearchBar />
        <FilterChips />
      </div>

      {templates.length > 0 ? (
        <TemplateGrid templates={templates} />
      ) : (
        <Surface className="empty-state" glint>
          <h2>No templates found</h2>
          <p>
            {q || category || type
              ? "No templates match the current search and filters — try clearing them."
              : "Upload your first campaign template to get started."}
          </p>
          <Guide id="engagement.templates.upload">
            <Link className="btn-primary" href="/templates/new">
              Upload a template
            </Link>
          </Guide>
        </Surface>
      )}
    </section>
  );
}
