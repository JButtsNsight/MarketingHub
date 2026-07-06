/**
 * Sign-out response builder for the Cognito/ALB front door.
 *
 * Kept in its own module (NOT `route.ts`) because Next.js only allows route
 * files to export recognized route fields (HTTP handlers, `dynamic`, etc.).
 * Exporting this pure, injectable helper here keeps it unit-testable while the
 * route file stays a thin wrapper.
 *
 * Signing out means two things must happen:
 *  1. Expire the ALB auth-session cookie (`AWSELBAuthSessionCookie-0/-1`) so the
 *     ALB stops treating this browser as authenticated.
 *  2. Redirect to the Cognito Hosted-UI `/logout` endpoint, which clears the
 *     Cognito session (and, via `IDPSignout`, the Google Workspace SAML
 *     session) and then bounces back to the registered `logout_uri`.
 */

const ALB_SESSION_COOKIE_SHARDS = [
  "AWSELBAuthSessionCookie-0",
  "AWSELBAuthSessionCookie-1",
];

/** An already-elapsed cookie so the browser drops the ALB session shard. */
function expiredCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Build the sign-out response: expire the ALB session cookies and 302 to the
 * Cognito Hosted-UI logout URL. Fails loud if the URL is not configured rather
 * than silently 404/redirect nowhere.
 */
export function buildLogoutResponse(logoutUrl: string | undefined): Response {
  if (!logoutUrl) {
    throw new Error(
      "COGNITO_LOGOUT_URL is not set — sign-out cannot redirect to the Cognito Hosted-UI logout endpoint (see AppStack task-def env / plan Phase 3 Task 3.3)",
    );
  }
  const headers = new Headers({ Location: logoutUrl });
  for (const shard of ALB_SESSION_COOKIE_SHARDS) {
    headers.append("Set-Cookie", expiredCookie(shard));
  }
  return new Response(null, { status: 302, headers });
}
