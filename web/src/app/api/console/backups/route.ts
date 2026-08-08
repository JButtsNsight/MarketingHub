import { AuthError, requireUser } from "@/lib/auth";
import {
  getBackupSnapshot,
  getLastArchivedAt,
  type BackupSnapshot,
} from "@/lib/console/backups";

/**
 * Backups console status feed — the refresh endpoint behind the (cloud-only in
 * Studio) Backups screen, fed by the host pgBackRest reporter cron instead of
 * the platform API.
 *
 * READ-ONLY — the only verb is GET; nothing here can trigger a backup or a
 * restore (restores are host operations run per the restore-drill runbook).
 * Gated on the `marketing` Cognito group like every console route.
 *
 * Honest degradation, mirroring the page:
 *   - `snapshot: null` (status table missing or empty) is a 200, not an error
 *     — the client renders the "host reporter not installed" empty state.
 *   - The pg_stat_archiver cross-check is best-effort: if that query fails,
 *     `lastArchivedAt` is null and the client shows "archiving unverifiable"
 *     instead of hiding the backup list.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

export interface BackupsStatusResponse {
  snapshot: BackupSnapshot | null;
  lastArchivedAt: string | null;
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Foundation-lib failures (`[console:<area>] <op> failed: <msg>`) are 400s. */
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:")) {
      return Response.json(
        {
          error: err.message.replace(
            /^\[console:[\w-]+\] (?:[\w-]+ failed: )?/,
            "",
          ),
        },
        { status: 400 },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const snapshot = await consoleAttempt(() => getBackupSnapshot());
  if (snapshot instanceof Response) return snapshot;

  // No stored status row: an honest empty state, not an error — and there is
  // no PITR window to cross-check without a snapshot to anchor it.
  if (snapshot === null) {
    const body: BackupsStatusResponse = { snapshot: null, lastArchivedAt: null };
    return Response.json(body);
  }

  let lastArchivedAt: string | null = null;
  try {
    lastArchivedAt = await getLastArchivedAt();
  } catch {
    // Best-effort cross-check: null renders as "archiving unverifiable".
    lastArchivedAt = null;
  }

  const body: BackupsStatusResponse = { snapshot, lastArchivedAt };
  return Response.json(body);
}
