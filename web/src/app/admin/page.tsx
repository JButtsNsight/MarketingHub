import { permanentRedirect } from "next/navigation";

// Never prerender: this exists only to answer requests at the old URL.
export const dynamic = "force-dynamic";

/**
 * The /admin landing page is gone (IA change: Admin is a nav group, not a
 * destination) — its Explore cards and storage stats moved to /overview; the
 * posture and backend-services reference always lived on /infrastructure.
 * Exact path only: /admin/auth, /admin/advisors and /admin/cloud are real
 * routes in the (app) group and are untouched.
 */
export default function AdminMovedRedirect() {
  permanentRedirect("/overview");
}
