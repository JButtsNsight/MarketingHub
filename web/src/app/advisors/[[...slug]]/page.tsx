import { permanentRedirect } from "next/navigation";

// Never prerender: this exists only to answer requests at the old URLs.
export const dynamic = "force-dynamic";

/**
 * Advisors moved from /advisors to /admin/advisors (IA change: it lives in
 * the Admin nav group now). This optional catch-all keeps every old link
 * answering with a 308 to its new home — same idiom as the /auth stub.
 */
export default async function AdvisorsMovedRedirect({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/admin/advisors${slug?.length ? `/${slug.join("/")}` : ""}`);
}
