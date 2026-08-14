import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { searchTemplates } from "@/lib/templates/repo";
import type { TemplateType } from "@/lib/templates/schema";
import { SearchBar } from "@/components/templates/SearchBar";
import { FilterChips } from "@/components/templates/FilterChips";
import { TemplateGrid } from "@/components/templates/TemplateGrid";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";
import { Tabs, type TabItem } from "@/components/ui/Tabs";

/**
 * The templates library, scoped to ONE campaign type. Since 2026-08-14 there
 * is no universal /templates page — SMS and Email each surface their own
 * templates as a tab (SMS_TABS / EMAIL_TABS), so `type` is locked by the
 * hosting page rather than read from the URL, and the type filter chips are
 * hidden. Browse/search/category behavior is unchanged; the upload flow and
 * template detail routes stay shared under /templates/*.
 */

type RawParams = Record<string, string | string[] | undefined>;

/** First value of a possibly-array searchParam, trimmed to a string. */
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export async function TemplatesView({
  searchParams,
  lockedType,
  tabs,
  tabsGuideId,
}: {
  searchParams: Promise<RawParams>;
  lockedType: TemplateType;
  tabs: TabItem[];
  tabsGuideId: string;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't be
  // browsed by an authenticated employee outside the `marketing` Cognito group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const params = await searchParams;
  const q = one(params.q);
  const category = one(params.category) || undefined;

  const templates = await searchTemplates(q, { category, type: lockedType }, db);
  const filtered = Boolean(q || category);

  return (
    <section className="templates-page">
      <Guide id={tabsGuideId}>
        <Tabs items={tabs} />
      </Guide>
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
        <FilterChips hideType />
      </div>

      {templates.length > 0 ? (
        <TemplateGrid templates={templates} />
      ) : (
        <Surface className="empty-state" glint>
          <h2>No templates found</h2>
          <p>
            {q || category
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

export default TemplatesView;
