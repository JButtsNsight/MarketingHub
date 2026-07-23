import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getConnectionInfo, getSmsCampaignsInfo } from "@/lib/console/settings";
import { PROJECT } from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

function yesNo(set: boolean) {
  return set ? <Badge tone="var(--data-3)">configured</Badge> : <Badge>not set</Badge>;
}

export default async function SettingsPage() {
  const user = await requireMarketingUser();
  const conn = getConnectionInfo();
  const sms = getSmsCampaignsInfo();

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title="Settings"
        subtitle="Runtime connection, project facts, and your account. Secret values are never displayed."
      />

      <div className="stack">
        <Section
          eyebrow="Runtime"
          title="Connection"
          description="How this container reaches the backend. Only presence is shown for secrets."
        >
          <KeyValue
            items={[
              {
                label: "Data API host",
                value: conn.supabaseUrlHost ?? "not set",
                mono: true,
              },
              { label: "Region", value: conn.region, mono: true },
              { label: "Service role key", value: conn.serviceRoleKeySet ? <Badge tone="var(--data-3)">configured (hidden)</Badge> : <Badge>not set</Badge> },
              { label: "ALB signer (ALB_ARN)", value: yesNo(conn.albArnSet) },
              { label: "Cognito logout URL", value: yesNo(conn.cognitoLogoutSet) },
              {
                label: "Preview auth shim",
                value: conn.previewAuth ? (
                  <Badge tone="var(--data-1)">on</Badge>
                ) : (
                  <Badge>off</Badge>
                ),
              },
            ]}
          />
        </Section>

        <Section
          eyebrow="Integrations"
          title="SMS Campaigns"
          description="Monday.com and SimpleTexting credentials. Only presence is shown — token values are never displayed."
        >
          <KeyValue
            items={[
              { label: "Monday.com API token", value: yesNo(sms.mondayTokenSet) },
              {
                label: "SimpleTexting webhook token",
                value: yesNo(sms.simpletextingWebhookTokenSet),
              },
              {
                label: "SimpleTexting send token",
                value: sms.simpletextingSendTokenSet ? (
                  <Badge tone="var(--data-3)">configured (hidden)</Badge>
                ) : (
                  // The web task cannot read the worker task's env, so this
                  // chip must never assert the secret exists — point at where
                  // to actually verify it instead.
                  <Badge title="SIMPLETEXTING_API_TOKEN is injected into the dispatcher worker task only — its presence cannot be read from the web task.">
                    managed on the worker task — verify via the worker log
                    heartbeat or Secrets Manager
                  </Badge>
                ),
              },
            ]}
          />
        </Section>

        <Section eyebrow="Project" title="Facts">
          <KeyValue
            items={[
              { label: "Name", value: PROJECT.name },
              { label: "AWS account", value: PROJECT.account, mono: true },
              { label: "Region", value: PROJECT.region, mono: true },
              { label: "Host", value: PROJECT.host },
              { label: "Supabase bundle", value: PROJECT.bundle, mono: true },
              { label: "Postgres", value: PROJECT.postgres },
              { label: "VPC CIDR", value: PROJECT.vpcCidr, mono: true },
            ]}
          />
        </Section>

        <Section eyebrow="Account" title="Your account">
          <KeyValue
            items={[
              { label: "Email", value: user.email, mono: true },
              { label: "Name", value: user.name },
              {
                label: "Groups",
                value: user.groups.length ? (
                  <span className="filter-group">
                    {user.groups.map((g) => (
                      <Badge key={g} tone="var(--data-4)">
                        {g}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "none"
                ),
              },
              {
                label: "Session",
                value: <a href="/logout" className="pager-link">Sign out</a>,
              },
            ]}
          />
        </Section>

        <Section eyebrow="Appearance" title="Theme & skin">
          <p className="note">
            Switch light/dark and glass/flat from the toggle in the masthead. Your
            choice persists in this browser.
          </p>
        </Section>
      </div>
    </>
  );
}
