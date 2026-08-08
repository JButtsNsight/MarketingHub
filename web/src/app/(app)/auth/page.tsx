import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { AUTH_TABS } from "@/lib/console/tabs";
import { COGNITO, REFERENCE_DISCLAIMER } from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

type Pool = (typeof COGNITO.pools)[number];
type Group = (typeof COGNITO.groups)[number];

const POOL_COLUMNS: Column<Pool>[] = [
  { key: "name", header: "user pool", mono: true, width: "30%" },
  { key: "purpose", header: "purpose" },
  { key: "group", header: "gated group", mono: true, width: "26%" },
];

const GROUP_COLUMNS: Column<Group>[] = [
  { key: "name", header: "group", mono: true, width: "26%" },
  { key: "grants", header: "grants" },
];

export default async function AuthPage() {
  const user = await requireMarketingUser();

  return (
    <>
      <PageHeader
        eyebrow="Authentication"
        title="Identity & access"
      />
      <Tabs items={AUTH_TABS} />

      <div className="stack">
        <Section eyebrow="Session" title="Your session">
          <KeyValue
            items={[
              { label: "Email", value: user.email, mono: true },
              { label: "Name", value: user.name },
              {
                label: "Cognito groups",
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
            ]}
          />
        </Section>

        <div className="split-2">
          <Section eyebrow="Cognito" title="User pools">
            <DataTable
              columns={POOL_COLUMNS}
              rows={COGNITO.pools}
              getRowKey={(p) => p.name}
            />
          </Section>
          <Section eyebrow="Access" title="Groups">
            <DataTable
              columns={GROUP_COLUMNS}
              rows={COGNITO.groups}
              getRowKey={(g) => g.name}
            />
          </Section>
        </div>

        <Section eyebrow="Model" title="How sign-in works">
          <KeyValue
            items={[
              { label: "Identity provider", value: COGNITO.idp },
              { label: "Session", value: COGNITO.session },
            ]}
          />
          <p className="ref-note">
            <Badge>reference</Badge>
            <span>
              {REFERENCE_DISCLAIMER} Live Cognito user lists live in the AWS
              console. GoTrue&apos;s own user store (empty by design today)
              and auth configuration are browsable read-only on the Users and
              Providers tabs.
            </span>
          </p>
        </Section>
      </div>
    </>
  );
}
