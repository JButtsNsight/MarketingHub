/**
 * Sign-out endpoint for the Cognito/ALB front door.
 *
 * The masthead `UserMenu` links "Sign out" here. Because the whole app sits
 * behind the ALB's `authenticate-cognito` default action, signing out means two
 * things must happen:
 *
 *  1. Expire the ALB auth-session cookie (`AWSELBAuthSessionCookie-0/-1`) so the
 *     ALB stops treating this browser as authenticated.
 *  2. Redirect to the Cognito Hosted-UI `/logout` endpoint, which clears the
 *     Cognito session (and, via `IDPSignout`, the Google Workspace SAML
 *     session) and then bounces back to the registered `logout_uri`.
 *
 * The fully-formed Hosted-UI logout URL (with `client_id` + registered
 * `logout_uri`) is provided by the AppStack task definition as
 * `COGNITO_LOGOUT_URL` — the app holds no Cognito config of its own. We fail
 * loud if it is missing rather than silently 404/redirect nowhere.
 */

// This route reads a runtime env var and sets cookies; never prerender it.
export const dynamic = "force-dynamic";

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
 * Cognito Hosted-UI logout URL. Pure/injectable so it is unit-testable without
 * the Next runtime.
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

export function GET(): Response {
  return buildLogoutResponse(process.env.COGNITO_LOGOUT_URL);
}
