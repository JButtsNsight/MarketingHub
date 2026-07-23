"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SmsCampaignRecipient } from "@/lib/sms/schema";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { statusLabel, statusTone } from "./statusBadge";

/** Keep error cells scannable; the full text stays in the cell title. */
const ERROR_MAX = 80;

type ReviewAction = "retry" | "mark_failed";

function truncate(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

/**
 * Outbox rows for one campaign. Read-only audit columns for every row;
 * `failed_ambiguous` rows (the send MAY have gone out — the dispatcher never
 * auto-retries them) additionally get the manual-review lane: Retry re-queues
 * the row as due-now pending, Mark failed declares it terminal. Both PATCH the
 * group-gated recipient route and `router.refresh()` so the server page
 * re-reads fresh rows; a 409 means someone else resolved the row first, which
 * the refresh will show.
 */
export function RecipientsTable({
  campaignId,
  recipients,
}: {
  campaignId: string;
  recipients: SmsCampaignRecipient[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = async (recipientId: string, action: ReviewAction) => {
    setError(null);
    setBusyId(recipientId);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/recipients/${recipientId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok && res.status !== 409) {
        setError(
          `The ${action === "retry" ? "retry" : "mark failed"} action failed. Please try again.`,
        );
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  // Rebuilt per render — the cells close over busyId and the review handler.
  const columns: Column<SmsCampaignRecipient>[] = [
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
      key: "st_message_id",
      header: "message id",
      mono: true,
      width: "140px",
      render: (r) => r.st_message_id ?? "—",
    },
    {
      key: "review",
      header: "review",
      width: "180px",
      // The manual lane for ambiguous sends only — a duplicate patient text
      // is worse than a missed one, so a human decides.
      render: (r) =>
        r.status === "failed_ambiguous" ? (
          <span className="campaign-actions">
            <button
              type="button"
              className="type-chip"
              disabled={busyId === r.id}
              onClick={() => review(r.id, "retry")}
            >
              Retry
            </button>
            <button
              type="button"
              className="type-chip"
              disabled={busyId === r.id}
              onClick={() => review(r.id, "mark_failed")}
            >
              Mark failed
            </button>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <DataTable
        columns={columns}
        rows={recipients}
        getRowKey={(r) => r.id}
        empty="No recipients."
      />
    </>
  );
}

export default RecipientsTable;
