import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listTemplates } from "@/lib/templates/repo";
import { isMondayConfigured } from "@/lib/monday/client";
import { NewCampaignForm } from "@/components/campaigns/NewCampaignForm";
import { Surface } from "@/components/Surface";

// Reads request-time identity + live template rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "New SMS campaign · MarketingHub",
};

/**
 * Campaign creation page. Server component: it gates on the marketing group,
 * loads the text templates the form can send, and degrades to a configuration
 * callout when the Monday.com integration is not set up (no board is linked
 * at first deploy — this state is expected, not an error).
 */
export default async function NewCampaignPage() {
  // Server-side group gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  if (!isMondayConfigured()) {
    return (
      <div className="page-narrow">
        <Surface className="empty-state" glint>
          <h2>Monday.com is not configured</h2>
          <p>
            Campaign creation reads recipients from a Monday.com board, and
            this environment has no <span className="mono">MONDAY_API_TOKEN</span>{" "}
            set. Add the token to the{" "}
            <span className="mono">marketinghub/sms-campaigns</span> secret and
            redeploy — see the deploy runbook{" "}
            <span className="mono">docs/runbooks/marketinghub-app-deploy.md</span>.
          </p>
        </Surface>
      </div>
    );
  }

  const templates = await listTemplates({ type: "text" });
  return (
    <div className="page-narrow">
      <NewCampaignForm templates={templates} />
    </div>
  );
}
