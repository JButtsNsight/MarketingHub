import { AuthError, requireUser } from "@/lib/auth";
import { DEFAULT_TTL_SECONDS, mintUserJwt } from "@/lib/userJwt";

/**
 * GET /api/realtime/token — realtime credentials for the CURRENT session.
 *
 * The browser joins Realtime channels through the app-origin ALB route
 * (`wss://<app-host>/realtime/v1/websocket`), which needs (a) the stack ANON
 * key as the `apikey` connect param (Kong key-auth) and (b) a JWT_SECRET-signed
 * user JWT as the channel-join token (RLS on realtime.messages). This route
 * hands the session BOTH.
 *
 * NOT impersonation — and a DELIBERATE, narrow relaxation of the Wave-4
 * "raw JWT never leaves the server" invariant: the minted token is the caller's
 * OWN identity (`mintUserJwt(user)` from the verified ALB/Cognito session; no
 * request parameter influences any claim), is short-lived (default 300s TTL,
 * never extended here), and carries role `authenticated` only. Handing your
 * own browser your own credential is the entire feature, so unlike the
 * impersonation console there is NO audit row and NO confirm handshake.
 *
 * Degradation contract: when the Wave-5 env is not applied
 * (SUPABASE_JWT_SECRET or SUPABASE_ANON_KEY unset) this responds
 * 503 {reason} so `fetchRealtimeToken()` returns null and every realtime
 * surface silently falls back to today's static behavior.
 */

// Per-user response: always compute per request, never cache across users.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Belt-and-braces alongside `dynamic`: no shared/proxy/browser caching. */
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request): Promise<Response> {
  // Same session gate as every console route: 401 unauthenticated, 403 when
  // the `marketing` Cognito group is missing.
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message },
        { status: err.status, headers: NO_STORE_HEADERS },
      );
    }
    throw err;
  }

  // Unflagged deployments answer 503 {reason} — clients fall back silently.
  if (!process.env.SUPABASE_JWT_SECRET) {
    return Response.json(
      {
        reason:
          "SUPABASE_JWT_SECRET is unset — realtime tokens require the Wave-4 " +
          "user-JWT flag (staged env change not applied yet).",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return Response.json(
      {
        reason:
          "SUPABASE_ANON_KEY is unset — the browser cannot open the realtime " +
          "socket without the stack anon apikey (staged env change not " +
          "applied yet).",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  // Computed BEFORE minting and floored to the second (mintUserJwt floors
  // `iat` the same way) so `expiresAtMs` can only ever UNDERSTATE the real
  // exp — clients refresh 60s early against this value. TTL is the module
  // default (300s) — this route never requests a longer-lived token.
  const expiresAtMs =
    (Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS) * 1000;

  // SELF identity only: claims come from the verified session user, and
  // mintUserJwt hard-codes role "authenticated". No request input is read.
  const token = await mintUserJwt(user);

  return Response.json(
    { token, expiresAtMs, anonKey },
    { headers: NO_STORE_HEADERS },
  );
}
