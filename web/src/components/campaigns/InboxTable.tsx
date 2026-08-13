"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { InboundMessageWithCampaign } from "@/lib/sms/repo";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Guide } from "@/components/guide/Guide";

/** Keep message cells scannable; the full text stays in the cell title. */
const BODY_MAX = 120;

function truncate(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

/**
 * Deterministic UTC minute stamp — locale/timezone formatting would differ
 * between the server render and the client hydration pass.
 */
function receivedStamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Inbound replies, newest first. Each row's workflow bit flips through
 * PATCH /api/inbox/[id] + router.refresh() so the server page re-reads fresh
 * rows. `showCampaign` is off when the table is embedded on a campaign detail
 * page (the column would repeat the page title).
 */
export function InboxTable({
  messages,
  showCampaign = true,
}: {
  messages: InboundMessageWithCampaign[];
  showCampaign?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setHandled = async (id: string, handled: boolean) => {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/inbox/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handled }),
      });
      if (!res.ok) {
        setError("Updating the message failed. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<InboundMessageWithCampaign>[] = [
    {
      key: "received_at",
      header: "received",
      mono: true,
      width: "170px",
      render: (m) => receivedStamp(m.received_at),
    },
    {
      key: "phone",
      header: "from",
      mono: true,
      width: "150px",
      render: (m) => m.phone_e164 ?? "—",
    },
    {
      key: "body",
      header: "message",
      render: (m) => <span title={m.body}>{truncate(m.body)}</span>,
    },
    ...(showCampaign
      ? [
          {
            key: "campaign",
            header: "campaign",
            width: "220px",
            render: (m) =>
              m.campaign ? (
                <Guide id="engagement.inbox.campaign-link">
                  <Link href={`/campaigns/${m.campaign.id}`}>
                    {m.campaign.name}
                  </Link>
                </Guide>
              ) : (
                "—"
              ),
          } satisfies Column<InboundMessageWithCampaign>,
        ]
      : []),
    {
      key: "handled",
      header: "status",
      width: "130px",
      render: (m) =>
        m.handled ? (
          <Badge tone="var(--ok)">handled</Badge>
        ) : (
          <Badge tone="var(--warn)">needs reply</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      width: "140px",
      render: (m) => (
        <Guide id="engagement.inbox.toggle-handled">
          <button
            type="button"
            className="type-chip"
            disabled={busyId === m.id}
            title={
              m.handled && m.handled_by
                ? `handled by ${m.handled_by}`
                : undefined
            }
            onClick={() => setHandled(m.id, !m.handled)}
          >
            {m.handled ? "Reopen" : "Mark handled"}
          </button>
        </Guide>
      ),
    },
  ];

  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Guide id="engagement.inbox.table">
        <DataTable
          columns={columns}
          rows={messages}
          getRowKey={(m) => m.id}
          empty="No replies yet."
        />
      </Guide>
    </>
  );
}

export default InboxTable;
