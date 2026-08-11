import { permanentRedirect } from "next/navigation";

// Never prerender: this exists only to answer requests at the old URL.
export const dynamic = "force-dynamic";

/**
 * Intel search moved onto the Competitor Intel landing page (IA change: the
 * search bar lives at the top of /intel, no separate pane). This stub keeps
 * every old link — including shared /intel/search?q=… searches — answering
 * with a 308 to /intel with the query string intact, where SearchPanel runs
 * the URL-driven search exactly as before. The /api/intel/search routes are
 * untouched.
 */
export default async function IntelSearchMovedRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value == null ? [] : [value]) {
      qs.append(key, v);
    }
  }
  const suffix = qs.toString();
  permanentRedirect(suffix ? `/intel?${suffix}` : "/intel");
}
