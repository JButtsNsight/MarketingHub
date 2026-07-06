import { buildLogoutResponse } from "./buildResponse";

/**
 * Sign-out endpoint for the Cognito/ALB front door.
 *
 * The masthead `UserMenu` links "Sign out" here. Because the whole app sits
 * behind the ALB's `authenticate-cognito` default action, sign-out expires the
 * ALB auth-session cookie and redirects to the Cognito Hosted-UI logout
 * endpoint. The fully-formed logout URL (with `client_id` + registered
 * `logout_uri`) is provided by the AppStack task definition as
 * `COGNITO_LOGOUT_URL`. The response is built by the injectable, unit-tested
 * `buildLogoutResponse` helper (see ./buildResponse).
 */

// This route reads a runtime env var and sets cookies; never prerender it.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return buildLogoutResponse(process.env.COGNITO_LOGOUT_URL);
}
