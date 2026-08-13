import { Guide } from "@/components/guide/Guide";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  getConnectionInfo,
  getPreviewPersona,
  getSmsCampaignsInfo,
} from "@/lib/console/settings";
import { PROJECT } from "@/lib/console/backend-map";
import { PersonaSwitch } from "./PersonaSwitch";

export const dynamic = "force-dynamic";

function yesNo(set: boolean) {
  return set ? <Badge tone="var(--data-3)">configured</Badge> : <Badge>not set</Badge>;
}

export default async function SettingsPage() {
  const user = await requireMarketingUser();
  const conn = getConnectionInfo();
  const sms = getSmsCampaignsInfo();
  const persona = await getPreviewPersona();

  return (
    <>
      <Guide id="overview.settings.header">
        <PageHeader
          eyebrow="Project"
          title="Settings"
        />
      </Guide>

      <div className="stack">
        <Section
          eyebrow="Runtime"
          title="Connection"
          description="How this container reaches the backend — secrets show presence only."
        >
          <Guide id="overview.settings.connection">
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
                    <span className="filter-group">
                      <Badge tone="var(--data-1)">on</Badge>
                      {persona && (
                        <Guide id="overview.settings.persona">
                          <PersonaSwitch persona={persona} />
                        </Guide>
                      )}
                    </span>
                  ) : (
                    <Badge>off</Badge>
                  ),
                },
              ]}
            />
          </Guide>
        </Section>

        <Section
          eyebrow="Integrations"
          title="SMS Campaigns"
          description="Monday.com and SimpleTexting credentials — presence shown, values never displayed."
        >
          <Guide id="overview.settings.sms-tokens">
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
                    <Guide id="overview.settings.worker-token">
                      <Badge title="SIMPLETEXTING_API_TOKEN is injected into the dispatcher worker task only — its presence cannot be read from the web task.">
                        managed on the worker task — verify via the worker log
                        heartbeat or Secrets Manager
                      </Badge>
                    </Guide>
                  ),
                },
              ]}
            />
          </Guide>
        </Section>

        <Section eyebrow="Project" title="Facts">
          <Guide id="overview.settings.facts">
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
          </Guide>
        </Section>

        <Section eyebrow="Account" title="Your account">
          <Guide id="overview.settings.account">
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
                  value: (
                    <Guide id="overview.settings.sign-out">
                      <a href="/logout" className="pager-link">Sign out</a>
                    </Guide>
                  ),
                },
              ]}
            />
          </Guide>
        </Section>
      </div>
    </>
  );
}
