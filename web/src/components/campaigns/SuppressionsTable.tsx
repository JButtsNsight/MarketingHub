"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SmsSuppression } from "@/lib/sms/schema";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";

/** Manual entries carry their provenance in raw ({added_by, note}). */
function manualMeta(s: SmsSuppression): { addedBy?: string; note?: string } {
  if (!s.raw || typeof s.raw !== "object" || Array.isArray(s.raw)) return {};
  const raw = s.raw as { added_by?: unknown; note?: unknown };
  return {
    addedBy: typeof raw.added_by === "string" ? raw.added_by : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
  };
}

/** Deterministic UTC stamp (see InboxTable — hydration-safe). */
function addedStamp(iso: string): string {
  return `${iso.slice(0, 10)}`;
}

/**
 * The STOP list. `stop` entries (the person texted STOP) are permanent and
 * carry no remove action — the server 409s any attempt anyway. `manual`
 * entries get a two-click remove (arm, then confirm) that DELETEs the
 * group-gated suppression route and refreshes the server page.
 */
export function SuppressionsTable({
  suppressions,
}: {
  suppressions: SmsSuppression[];
}) {
  const router = useRouter();
  const [busyPhone, setBusyPhone] = useState<string | null>(null);
  const [armedPhone, setArmedPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (phone: string) => {
    setError(null);
    setBusyPhone(phone);
    try {
      const res = await fetch(
        `/api/suppressions/${encodeURIComponent(phone)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Removing the entry failed. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyPhone(null);
      setArmedPhone(null);
    }
  };

  const columns: Column<SmsSuppression>[] = [
    {
      key: "phone",
      header: "phone",
      mono: true,
      width: "160px",
      render: (s) => s.phone_e164,
    },
    {
      key: "reason",
      header: "reason",
      width: "140px",
      render: (s) =>
        s.reason === "stop" ? (
          <Badge tone="var(--idle)">STOP (texted)</Badge>
        ) : (
          <Badge tone="var(--warn)">manual</Badge>
        ),
    },
    {
      key: "added",
      header: "added",
      mono: true,
      width: "110px",
      render: (s) => addedStamp(s.created_at),
    },
    {
      key: "by",
      header: "added by",
      render: (s) =>
        s.reason === "manual" ? (manualMeta(s).addedBy ?? "—") : "webhook",
    },
    {
      key: "note",
      header: "note",
      render: (s) => manualMeta(s).note ?? "—",
    },
    {
      key: "actions",
      header: "",
      width: "170px",
      render: (s) =>
        s.reason === "manual" ? (
          <span className="campaign-actions">
            {armedPhone === s.phone_e164 ? (
              <>
                <button
                  type="button"
                  className="type-chip"
                  disabled={busyPhone === s.phone_e164}
                  onClick={() => remove(s.phone_e164)}
                >
                  Confirm remove
                </button>
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => setArmedPhone(null)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="type-chip"
                onClick={() => setArmedPhone(s.phone_e164)}
              >
                Remove
              </button>
            )}
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
        rows={suppressions}
        getRowKey={(s) => s.phone_e164}
        empty="No suppressed numbers match."
      />
    </>
  );
}

export default SuppressionsTable;
