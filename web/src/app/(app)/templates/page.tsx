import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /templates retired as a page 2026-08-14 — templates live as a tab inside
 * each campaign section (/campaigns/templates for SMS, /email/templates for
 * email). Old bookmarks land on the SMS view with their search/filter params
 * intact (email-type bookmarks carried ?type=email — honor it). The upload
 * flow (/templates/new) and template detail routes stay at /templates/*.
 */
export default async function TemplatesRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v && key !== "type") qs.set(key, v);
  }
  const type = Array.isArray(params.type) ? params.type[0] : params.type;
  const base = type === "email" ? "/email/templates" : "/campaigns/templates";
  redirect(qs.size > 0 ? `${base}?${qs.toString()}` : base);
}
