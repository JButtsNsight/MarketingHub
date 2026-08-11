import { Surface } from "@/components/Surface";

/**
 * Terse 403 panel for the admin-gated surfaces. Rendered in place of the page
 * body when `requireAdminUser()` returns `{ ok: false }` — the user IS signed
 * in and just lacks the admin group, so bouncing to /login would read as a
 * redirect loop. Purely presentational — safe in server components.
 */
export function Forbidden() {
  return (
    <Surface className="empty-state" glint>
      <h2>403</h2>
      <p role="alert">Admin access required.</p>
    </Surface>
  );
}

export default Forbidden;
