import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { getContactList, getListMembers } from "@/lib/contacts/repo";
import type { ContactListMember } from "@/lib/contacts/schema";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";
import { ListActions } from "@/components/campaigns/ListActions";

// Reads request-time identity + live member rows; never prerender.
export const dynamic = "force-dynamic";

const MEMBER_COLUMNS: Column<ContactListMember>[] = [
  { key: "name", header: "name", render: (m) => m.name || "—" },
  {
    key: "phone",
    header: "phone",
    mono: true,
    width: "160px",
    render: (m) => m.phone_e164 ?? m.raw_phone ?? "—",
  },
  {
    key: "reason",
    header: "status",
    width: "110px",
    // invalid/duplicate are data classifications, not failures — never red.
    render: (m) => (
      <Badge tone={m.reason === "ok" ? "var(--ok)" : undefined}>
        {m.reason}
      </Badge>
    ),
  },
  {
    key: "consent",
    header: "consent",
    width: "220px",
    // Provenance verbatim from the uploaded sheet — audit evidence of what
    // was claimed at import time, never validated or parsed.
    render: (m) =>
      m.consent_source || m.consent_date ? (
        <span title="as provided in the uploaded sheet">
          {[m.consent_source, m.consent_date].filter(Boolean).join(" · ")}
        </span>
      ) : (
        "—"
      ),
  },
];

/**
 * Single contact-list view. Server component: metadata + (for uploaded
 * sheets) the parsed members with their classifications; Monday-linked lists
 * show the saved board coordinates — membership is live at campaign time.
 */
export default async function ContactListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Server-side group gate: mirrors the API handlers.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const { id } = await params;
  const list = await getContactList(id, db);
  if (!list) notFound();

  const members = list.source === "csv" ? await getListMembers(id, db) : [];

  return (
    <>
      <PageHeader
        eyebrow="Contact list"
        title={list.name}
        subtitle={
          <>
            <Badge
              tone={list.source === "monday" ? "var(--data-2)" : "var(--data-3)"}
            >
              {list.source === "monday" ? "monday board" : "uploaded sheet"}
            </Badge>{" "}
            {list.source === "monday" ? (
              <>
                {list.monday_board_name}{" "}
                <span className="mono">
                  #{list.monday_board_id} · column {list.monday_phone_column_id}
                </span>
              </>
            ) : (
              <span className="mono">{list.original_filename}</span>
            )}
            {" · by "}
            <span className="mono">{list.created_by}</span>
          </>
        }
        actions={
          <>
            <Link className="type-chip" href="/campaigns/lists">
              All lists
            </Link>
            <ListActions listId={list.id} />
          </>
        }
      />

      <div className="stack">
        {list.source === "csv" ? (
          <>
            <div className="stat-grid">
              <StatCard
                label="Contacts"
                value={list.contact_count}
                hint="usable numbers"
                accent="var(--data-3)"
              />
              <StatCard label="Invalid" value={list.invalid_count} hint="unusable numbers" />
              <StatCard
                label="Duplicates"
                value={list.duplicate_count}
                hint="first occurrence kept"
              />
            </div>
            <DataTable
              columns={MEMBER_COLUMNS}
              rows={members}
              getRowKey={(m) => m.id}
              empty="No rows in this list."
            />
          </>
        ) : (
          <Surface className="empty-state" glint>
            <h2>Live Monday membership</h2>
            <p>
              Recipients are fetched from the Monday board at campaign-creation
              time.
            </p>
          </Surface>
        )}
      </div>
    </>
  );
}
