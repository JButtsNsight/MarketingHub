import { buildRefreshResponse } from "./buildResponse";

// Session refresh for first-sign-in auto-provisioning: expiring the ALB
// cookies is per-browser and non-destructive (worst case: a silent re-auth),
// so the route is unauthenticated by design — like /logout.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return buildRefreshResponse();
}
