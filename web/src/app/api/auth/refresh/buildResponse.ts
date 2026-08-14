/**
 * Session-refresh response builder (first-sign-in auto-provisioning).
 *
 * A freshly auto-granted group is invisible to the CURRENT ALB session — the
 * access token was minted before the grant, and it lives up to 12h. Expiring
 * the ALB session cookie shards forces the ALB to re-run its OIDC flow on the
 * next request; Cognito still holds ITS session, so the round trip is silent
 * (no Google prompt) and the fresh token carries the new group.
 *
 * Mirrors app/logout/buildResponse.ts (same shard names, same reasons) but
 * redirects INTO the app instead of to the Cognito logout endpoint, and sets
 * a short-lived guard cookie so /login can never loop grant→refresh→grant if
 * something upstream keeps the token group-less.
 */

const ALB_SESSION_COOKIE_SHARDS = [
  "AWSELBAuthSessionCookie-0",
  "AWSELBAuthSessionCookie-1",
];

/** Loop guard: while present, /login must not auto-provision again. */
export const AUTO_PROVISION_GUARD_COOKIE = "mh-autoprov";
export const AUTO_PROVISION_GUARD_MAX_AGE_S = 120;

/** An already-elapsed cookie so the browser drops the ALB session shard. */
function expiredCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

/** Expire the ALB session, arm the loop guard, and 302 into the app. */
export function buildRefreshResponse(): Response {
  const headers = new Headers({ Location: "/overview" });
  for (const shard of ALB_SESSION_COOKIE_SHARDS) {
    headers.append("Set-Cookie", expiredCookie(shard));
  }
  headers.append(
    "Set-Cookie",
    `${AUTO_PROVISION_GUARD_COOKIE}=1; Path=/; Max-Age=${AUTO_PROVISION_GUARD_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 302, headers });
}
