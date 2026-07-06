/**
 * Liveness/health endpoint for the ALB target-group health check.
 *
 * This route is UNAUTHENTICATED by design: the front-door ALB (see
 * `app-infra/lib/app-stack.ts`) routes `/api/health` with a plain forward, a
 * higher-priority rule that bypasses the `authenticate-cognito` default action.
 * It therefore reads no identity header and returns a fixed 200 payload so the
 * ALB (and any external uptime probe) can confirm the container is serving.
 */

// Never prerender/cache — the ALB polls this at request time.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { status: 200 });
}
