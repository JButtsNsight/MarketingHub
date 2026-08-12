import { z } from "zod";

import { AuthError, type AppUser } from "@/lib/auth";
import { ADMIN_GROUP, ALL_ASSIGNABLE_GROUPS } from "@/lib/authGroups";
import { requireAdminApi } from "@/lib/requireAdminUser";
import { addToGroup, listPoolUsers, removeFromGroup } from "@/lib/cognitoAdmin";

/**
 * Cognito group grants/revokes (Wave D Users & Roles) — the WRITE side of
 * /admin/users. POST only; admin-gated with the same live pool check as
 * `requireAdminUser`, but UNCACHED (`fresh: true`): a mutation is worth one
 * extra pool round-trip, so even an OUT-OF-BAND revocation (AWS console/CLI —
 * nothing busts this app's cache) locks a revoked admin out of granting
 * immediately, not after the 60s TTL.
 *
 * Hard server-side guards, independent of anything the UI disables:
 *   - `group` must be in the fixed registry (ALL_ASSIGNABLE_GROUPS) — this
 *     API can never touch a group the code doesn't know about.
 *   - Own god-mode (`marketinghub-admins`) is untouchable: remove = lockout
 *     prevention; add = self-escalation (a no-op for a real admin, a
 *     re-admin move for a stale one riding the fail-open path). Target email
 *     compared to the actor's, case-insensitively.
 * Every applied change emits a structured audit line (who did what to whom).
 * The foundation's mutation helpers bust the liveGroupsFor cache themselves,
 * so in-app revocation lands on the next admin render, not after the 60s TTL.
 */

export const dynamic = "force-dynamic";

const GrantSchema = z.object({
  username: z.string().trim().min(1, "username is required").max(128),
  group: z
    .string()
    .refine((g) => ALL_ASSIGNABLE_GROUPS.includes(g), {
      message: "group is not in the assignable registry",
    }),
  action: z.enum(["add", "remove"]),
});

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    // 403 body is the fixed "admin-only" marker; 401 keeps the lib's message.
    return Response.json(
      { error: err.status === 403 ? "admin-only" : err.message },
      { status: err.status },
    );
  }
  throw err;
}

export async function POST(req: Request): Promise<Response> {
  let actor: AppUser;
  try {
    // Write path: the live pool check is UNCACHED (see the header comment).
    actor = await requireAdminApi(req.headers, { fresh: true });
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = GrantSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { username, group, action } = parsed.data;

  try {
    // Resolve the target from the pool: gives the 404 for unknown usernames,
    // the target email for the lockout compare, and the audit line's subject.
    const target = (await listPoolUsers()).find((u) => u.username === username);
    if (!target) {
      return Response.json(
        { error: "No user with that username" },
        { status: 404 },
      );
    }

    // Own god-mode is untouchable — server-enforced, whatever the UI
    // disabled. Remove = lockout prevention; add = self-escalation guard
    // (never a legitimate move: a real admin already holds the group).
    if (
      group === ADMIN_GROUP &&
      target.email.toLowerCase() === actor.email.toLowerCase()
    ) {
      return Response.json(
        {
          error:
            action === "remove"
              ? "You can't remove your own god-mode."
              : "You can't grant your own god-mode.",
        },
        { status: 403 },
      );
    }

    if (action === "add") await addToGroup(username, group);
    else await removeFromGroup(username, group);

    // Loud structured audit line on EVERY applied change.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        msg: "cognito group grant",
        actor: actor.email,
        target: target.email,
        username,
        group,
        action,
      }),
    );
    return Response.json({ ok: true });
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: "cognito group grant failed",
        actor: actor.email,
        username,
        group,
        action,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "Cognito pool did not answer.", unavailable: true },
      { status: 503 },
    );
  }
}
