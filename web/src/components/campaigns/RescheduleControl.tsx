"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CampaignStatus } from "@/lib/sms/schema";
import {
  formatSlot,
  isWeekday,
  SEND_SLOTS,
  SEND_TIMEZONES,
} from "@/lib/sms/schedule";
import { Surface } from "../Surface";
import { Guide } from "@/components/guide/Guide";

/**
 * Reschedule control for a campaign that has not started sending. Collapsed
 * to a button; expanded it PATCHes `{action: "reschedule"}` with the new
 * weekday date + 30-minute slot + fallback US zone (recipients with their own
 * zone recompute server-side) and refreshes the server page. A
 * 409 means the dispatcher promoted the campaign mid-edit — refresh shows
 * the real state.
 */
export function RescheduleControl({
  campaignId,
  status,
  sendDate,
  sendTime,
  sendTimezone,
}: {
  campaignId: string;
  status: CampaignStatus;
  sendDate: string;
  sendTime: string;
  sendTimezone: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(sendDate);
  const [time, setTime] = useState(sendTime);
  const [zone, setZone] = useState(sendTimezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only a not-yet-sending campaign can move.
  if (status !== "scheduled" && status !== "paused") return null;

  const onSave = async () => {
    if (!date) {
      setError("Pick a send date.");
      return;
    }
    if (!isWeekday(date)) {
      setError("Blasts only go out Monday–Friday.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reschedule",
          sendDate: date,
          sendTime: time,
          sendTimezone: zone,
        }),
      });
      if (res.status === 409) {
        // The guard lost (campaign started sending) — show the real state.
        router.refresh();
        return;
      }
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Reschedule failed. Please try again.");
        setBusy(false);
        return;
      }
      setBusy(false);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Guide id="campaigns.detail.reschedule">
        <button type="button" className="type-chip" onClick={() => setOpen(true)}>
          Reschedule
        </button>
      </Guide>
    );
  }

  return (
    <Surface className="reschedule-pop" elevated={false}>
      <div className="field">
        <label htmlFor="resch-date">Send date (Mon–Fri)</label>
        <Guide id="campaigns.detail.reschedule-date">
          <input
            id="resch-date"
            type="date"
            className="surface control"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Guide>
      </div>
      <div className="field">
        <label htmlFor="resch-zone">Fallback zone</label>
        <Guide id="campaigns.detail.reschedule-zone">
          <select
            id="resch-zone"
            className="surface control"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          >
            {SEND_TIMEZONES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </Guide>
        <p className="note">Fallback for contacts without a timezone.</p>
      </div>
      <div className="field">
        <label htmlFor="resch-time">Send time</label>
        <Guide id="campaigns.detail.reschedule-time">
          <select
            id="resch-time"
            className="surface control"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          >
            {SEND_SLOTS.map((s) => (
              <option key={s} value={s}>
                {formatSlot(s)}
              </option>
            ))}
          </select>
        </Guide>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Guide id="campaigns.detail.reschedule-cancel">
          <button
            type="button"
            className="type-chip"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            disabled={busy}
          >
            Cancel
          </button>
        </Guide>
        <Guide id="campaigns.detail.reschedule-save">
          <button
            type="button"
            className="btn-primary"
            onClick={onSave}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save schedule"}
          </button>
        </Guide>
      </div>
    </Surface>
  );
}

export default RescheduleControl;
