"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AttentionRecipient } from "@/lib/sms/repo";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { statusLabel, statusTone } from "./statusBadge";
import { Guide } from "@/components/guide/Guide";

/** Keep error cells scannable; the full text stays in the cell title. */
const ERROR_MAX = 70;

type ReviewAction = "retry" | "mark_failed" | "mark_sent";

const ACTION_LABEL: Record<ReviewAction, string> = {
  retry: "retry",
  mark_failed: "mark failed",
  mark_sent: "mark sent",
};

function truncate(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

/**
 * The cross-campaign review queue. Row actions follow the same doctrine as
 * the per-campaign review lane (RecipientsTable):
 *
 * - `failed_ambiguous` — the POST may have landed; a human picks Retry
 *   (re-queue due-now), Mark sent (evidence it landed), or Mark failed.
 * - `failed`           — terminal after retries; Retry is the only move.
 * - `undelivered`      — the carrier rejected a POST that DID land; retrying
 *   would double-text, so these rows are informational only.
 *
 * Retry is never offered inside a canceled campaign (the server 409s it).
 */
export function AttentionTable({ rows }: { rows: AttentionRecipient[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = async (row: AttentionRecipient, action: ReviewAction) => {
    setError(null);
    setBusyId(row.id);
    try {
      const res = await fetch(
        `/api/campaigns/${row.campaign_id}/recipients/${row.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok && res.status !== 409) {
        setError(
          `The ${ACTION_LABEL[action]} action failed. Please try again.`,
        );
        return;
      }
      // A 409 means someone else resolved the row first — the refresh below
      // shows the fresh truth either way.
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<AttentionRecipient>[] = [
    {
      key: "campaign",
      header: "campaign",
      width: "200px",
      render: (r) =>
        r.campaign ? (
          <Guide id="engagement.review.campaign-link">
            <Link href={`/campaigns/${r.campaign.id}`}>{r.campaign.name}</Link>
          </Guide>
        ) : (
          <span className="mono">{r.campaign_id}</span>
        ),
    },
    { key: "name", header: "name" },
    {
      key: "phone",
      header: "phone",
      mono: true,
      width: "150px",
      render: (r) => r.phone_e164 ?? "—",
    },
    {
      key: "status",
      header: "status",
      width: "150px",
      render: (r) => (
        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
      ),
    },
    {
      key: "attempts",
      header: "attempts",
      mono: true,
      align: "right",
      width: "80px",
      render: (r) => r.attempts,
    },
    {
      key: "last_error",
      header: "last error",
      render: (r) =>
        r.last_error ? (
          <span title={r.last_error}>{truncate(r.last_error)}</span>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      header: "resolve",
      width: "260px",
      render: (r) => {
        const canRetry =
          (r.status === "failed_ambiguous" || r.status === "failed") &&
          r.campaign?.status !== "canceled";
        const ambiguous = r.status === "failed_ambiguous";
        if (!canRetry && !ambiguous) return null;
        return (
          <span className="campaign-actions">
            {canRetry ? (
              <Guide id="engagement.review.retry">
                <button
                  type="button"
                  className="type-chip"
                  disabled={busyId === r.id}
                  onClick={() => review(r, "retry")}
                >
                  Retry
                </button>
              </Guide>
            ) : null}
            {ambiguous ? (
              <>
                <Guide id="engagement.review.mark-sent">
                  <button
                    type="button"
                    className="type-chip"
                    disabled={busyId === r.id}
                    onClick={() => review(r, "mark_sent")}
                  >
                    Mark sent
                  </button>
                </Guide>
                <Guide id="engagement.review.mark-failed">
                  <button
                    type="button"
                    className="type-chip"
                    disabled={busyId === r.id}
                    onClick={() => review(r, "mark_failed")}
                  >
                    Mark failed
                  </button>
                </Guide>
              </>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Guide id="engagement.review.table">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.id}
          empty="Nothing needs attention."
        />
      </Guide>
    </>
  );
}

export default AttentionTable;
