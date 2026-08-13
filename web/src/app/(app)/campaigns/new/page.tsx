import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { listTemplates } from "@/lib/templates/repo";
import { listContactLists } from "@/lib/contacts/repo";
import { NewCampaignForm } from "@/components/campaigns/NewCampaignForm";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";

// Reads request-time identity + live template/list rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "New SMS campaign · MarketingHub",
};

/**
 * Campaign creation page. Server component: it gates on the marketing group
 * and loads the text templates + contact lists the form selects from. No
 * Monday gate — uploaded-sheet lists need no integration at all, and creating
 * from a Monday-linked list surfaces the configuration callout only when it
 * actually applies (the create 503).
 */
export default async function NewCampaignPage() {
  // Server-side group gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the `marketing` group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const [templates, lists] = await Promise.all([
    listTemplates({ type: "text" }, db),
    listContactLists(db),
  ]);

  if (lists.length === 0) {
    return (
      <div className="page-narrow">
        <Surface className="empty-state" glint>
          <h2>No contact lists yet</h2>
          <p>
            A campaign needs an audience — upload a CSV or link a Monday.com
            board first.
          </p>
          <Guide id="campaigns.new.create-list-link">
            <Link className="btn-primary" href="/campaigns/lists/new">
              Create a contact list
            </Link>
          </Guide>
        </Surface>
      </div>
    );
  }

  return (
    <div className="page-narrow">
      <NewCampaignForm templates={templates} lists={lists} />
    </div>
  );
}
