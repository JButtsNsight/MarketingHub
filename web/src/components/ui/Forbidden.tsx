import { Surface } from "@/components/Surface";

/**
 * Terse 403 panel for the gated surfaces. Rendered in place of the page body
 * when `requireAdminUser()` / `requireSectionUser()` returns `{ ok: false }` —
 * the user IS signed in and just lacks the group, so bouncing to /login would
 * read as a redirect loop. Purely presentational — safe in server components.
 */
export function Forbidden({
  message = "Admin access required.",
}: {
  message?: string;
}) {
  return (
    <Surface className="empty-state" glint>
      <h2>403</h2>
      <p role="alert">{message}</p>
    </Surface>
  );
}

export default Forbidden;
