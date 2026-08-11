import { permanentRedirect } from "next/navigation";

// Never prerender: this exists only to answer requests at the old URLs.
export const dynamic = "force-dynamic";

/**
 * The Authentication section moved from /auth/* to /admin/auth/* (IA change:
 * folded into the Admin area). This optional catch-all keeps every old deep
 * link — /auth, /auth/users, /auth/providers, /auth/impersonate — answering
 * with a 308 to its new home. Only the console PAGES moved: GoTrue's
 * /auth/v1/* API paths are upstream Kong routes, not Next routes, and are
 * untouched.
 */
export default async function AuthMovedRedirect({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/admin/auth${slug?.length ? `/${slug.join("/")}` : ""}`);
}
