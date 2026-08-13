import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { requireAdminUser } from "@/lib/requireAdminUser";
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
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;
  const user = gate.user;

  return (
    <>
      <Guide id="auth-admin.overview.header">
        <PageHeader
          eyebrow="Authentication"
          title="Identity & access"
        />
      </Guide>
      <Guide id="auth-admin.auth.tabs">
        <Tabs items={AUTH_TABS} />
      </Guide>

      <div className="stack">
        <Section eyebrow="Session" title="Your session">
          <Guide id="auth-admin.overview.session">
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
          </Guide>
        </Section>

        <div className="split-2">
          <Section eyebrow="Cognito" title="User pools">
            <Guide id="auth-admin.overview.pools-table">
              <DataTable
                columns={POOL_COLUMNS}
                rows={COGNITO.pools}
                getRowKey={(p) => p.name}
              />
            </Guide>
          </Section>
          <Section eyebrow="Access" title="Groups">
            <Guide id="auth-admin.overview.groups-table">
              <DataTable
                columns={GROUP_COLUMNS}
                rows={COGNITO.groups}
                getRowKey={(g) => g.name}
              />
            </Guide>
          </Section>
        </div>

        <Section eyebrow="Model" title="How sign-in works">
          <Guide id="auth-admin.overview.signin-model">
            <KeyValue
              items={[
                { label: "Identity provider", value: COGNITO.idp },
                { label: "Session", value: COGNITO.session },
              ]}
            />
          </Guide>
          <Guide id="auth-admin.auth.reference-note">
            <p className="ref-note">
              <Badge>reference</Badge>
              <span>
                {REFERENCE_DISCLAIMER} Live Cognito user lists live in the AWS
                console.
              </span>
            </p>
          </Guide>
        </Section>
      </div>
    </>
  );
}
