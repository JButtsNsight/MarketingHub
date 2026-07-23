import "server-only";

/**
 * Server-only SimpleTexting v2 API client.
 *
 * Sends a single SMS via `POST /messages` (verified 2026-07-22: the v2 API has
 * no scheduling field — all scheduling, throttling, and retry policy lives in
 * the dispatcher worker). This module performs exactly one POST attempt and
 * classifies the outcome; it holds the bearer token, so it must never be
 * imported from client components.
 */

/**
 * True when the SimpleTexting API token is configured. The dispatcher idles
 * (graceful degradation) and the UI shows a callout when this is false.
 */
export function isSimpleTextingConfigured(): boolean {
  return Boolean(process.env.SIMPLETEXTING_API_TOKEN);
}
