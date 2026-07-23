"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CampaignStatus } from "@/lib/sms/schema";

type CampaignAction = "pause" | "resume" | "cancel";

/**
 * Cancel warning — the dispatcher sends sequentially and never interrupts an
 * in-flight POST, so cancel cannot recall a message already on the wire.
 */
const CANCEL_CONFIRM =
  "Cancel this campaign? Recipients not yet sent will never be sent, and an in-flight message may still send. This cannot be undone.";

/**
 * Pause / Resume / Cancel controls for one campaign. Buttons are enabled per
 * the campaign state machine; each action PATCHes the group-gated campaign
 * route and then `router.refresh()`es so the server page re-reads the fresh
 * status. A 409 means the status guard lost server-side (someone else moved
 * the campaign first) — refreshing shows the real state, so it is not an
 * error here.
 */
export function CampaignActions({
  campaignId,
  status,
}: {
  campaignId: string;
  status: CampaignStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canPause = status === "scheduled" || status === "sending";
  const canResume = status === "paused";
  const canCancel =
    status === "scheduled" || status === "sending" || status === "paused";

  const act = async (action: CampaignAction) => {
    if (action === "cancel" && !window.confirm(CANCEL_CONFIRM)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok && res.status !== 409) {
        setError(`The ${action} action failed. Please try again.`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="campaign-actions">
      <button
        type="button"
        className="type-chip"
        disabled={busy || !canPause}
        onClick={() => act("pause")}
      >
        Pause
      </button>
      <button
        type="button"
        className="type-chip"
        disabled={busy || !canResume}
        onClick={() => act("resume")}
      >
        Resume
      </button>
      <button
        type="button"
        className="type-chip"
        disabled={busy || !canCancel}
        onClick={() => act("cancel")}
      >
        Cancel
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default CampaignActions;
