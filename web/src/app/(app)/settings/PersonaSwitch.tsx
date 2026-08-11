"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";

/** Preview-only persona cookie — the same one lib/auth.ts's shim consults. */
const COOKIE = "mh-preview-persona";

/**
 * Persona chip + flip for the PREVIEW_AUTH shim (rendered only while the shim
 * is on; real ALB auth never consults the cookie). `persona` is resolved
 * server-side through the SAME getUser path as the route gates, so the chip
 * can never disagree with them. The flip writes/clears the cookie and reloads;
 * "back to admin" only appears when the demote cookie caused `member` — a shim
 * that never granted the admin group has nothing to restore.
 */
export function PersonaSwitch({ persona }: { persona: "admin" | "member" }) {
  // Cookie state is client-only; resolve after mount (SSR paints the chip).
  const [demoted, setDemoted] = useState(false);
  useEffect(() => {
    setDemoted(
      document.cookie
        .split(";")
        .some((pair) => pair.trim() === `${COOKIE}=member`),
    );
  }, []);

  function flip(toMember: boolean) {
    document.cookie = toMember
      ? `${COOKIE}=member; path=/`
      : `${COOKIE}=; path=/; max-age=0`;
    location.reload();
  }

  return (
    <>
      <Badge tone="var(--data-4)">persona: {persona}</Badge>
      {persona === "admin" ? (
        <button type="button" className="type-chip" onClick={() => flip(true)}>
          View as member
        </button>
      ) : demoted ? (
        <button type="button" className="type-chip" onClick={() => flip(false)}>
          Back to admin
        </button>
      ) : null}
    </>
  );
}

export default PersonaSwitch;
