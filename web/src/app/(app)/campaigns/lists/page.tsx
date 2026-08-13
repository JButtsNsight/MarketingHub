import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { listContactLists } from "@/lib/contacts/repo";
import type { ContactList } from "@/lib/contacts/schema";
import { Guide } from "@/components/guide/Guide";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";

// Reads request-time identity + live list rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Contact lists · MarketingHub",
};

const COLUMNS: Column<ContactList>[] = [
  {
    key: "name",
    header: "name",
    render: (l) => (
      <Guide id="campaigns.lists.open-list">
        <Link href={`/campaigns/lists/${l.id}`}>{l.name}</Link>
      </Guide>
    ),
  },
  {
    key: "source",
    header: "source",
    width: "130px",
    render: (l) => (
      <Badge tone={l.source === "monday" ? "var(--data-2)" : "var(--data-3)"}>
        {l.source === "monday" ? "monday board" : "uploaded sheet"}
      </Badge>
    ),
  },
  {
    key: "detail",
    header: "detail",
    render: (l) =>
      l.source === "monday" ? (
        <span>
          {l.monday_board_name ?? "—"}{" "}
          <span className="mono">#{l.monday_board_id}</span>
        </span>
      ) : (
        <span className="mono">{l.original_filename ?? "—"}</span>
      ),
  },
  {
    key: "contacts",
    header: "contacts",
    mono: true,
    align: "right",
    width: "100px",
    // Monday lists are live — membership is whatever the board holds today.
    render: (l) => (l.source === "monday" ? "live" : l.contact_count),
  },
  {
    key: "created",
    header: "created",
    mono: true,
    width: "110px",
    render: (l) => l.created_at.slice(0, 10),
  },
];

/**
 * Contact-lists management. Server component: every saved recipient source
 * (uploaded sheets + linked Monday boards), newest first. Lists are what the
 * campaign builder picks its audience from.
 */
export default async function ContactListsPage() {
  // Server-side group gate: mirrors the API handlers.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const contactLists = await listContactLists(db);

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title={
          <Guide id="campaigns.lists.title">
            <span>Contact lists</span>
          </Guide>
        }
        count={`${contactLists.length} total`}
        actions={
          <>
            <Guide id="campaigns.lists.campaigns-link">
              <Link className="type-chip" href="/campaigns">
                Campaigns
              </Link>
            </Guide>
            <Guide id="campaigns.lists.new-link">
              <Link className="btn-primary" href="/campaigns/lists/new">
                New list
              </Link>
            </Guide>
          </>
        }
      />

      {contactLists.length > 0 ? (
        <Guide id="campaigns.lists.table">
          <DataTable
            columns={COLUMNS}
            rows={contactLists}
            getRowKey={(l) => l.id}
            empty="No lists."
          />
        </Guide>
      ) : (
        <Surface className="empty-state" glint>
          <h2>No contact lists yet</h2>
          <p>Upload a CSV of contacts or link a Monday.com board.</p>
          <Guide id="campaigns.lists.new-link">
            <Link className="btn-primary" href="/campaigns/lists/new">
              New list
            </Link>
          </Guide>
        </Surface>
      )}
    </>
  );
}
