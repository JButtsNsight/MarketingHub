import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getConnectionInfo } from "@/lib/console/settings";
import { PROJECT } from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

function yesNo(set: boolean) {
  return set ? <Badge tone="var(--data-3)">configured</Badge> : <Badge>not set</Badge>;
}

export default async function SettingsPage() {
  const user = await requireMarketingUser();
  const conn = getConnectionInfo();

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
