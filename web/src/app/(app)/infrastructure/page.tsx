import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList } from "@/components/ui/RefList";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { requireAdminUser } from "@/lib/requireAdminUser";
import {
  SERVICES,
  BUCKETS,
  SECURITY_POSTURE,
  BACKUPS_DR,
  OBSERVABILITY,
  NETWORK,
  NOT_ENABLED,
  REFERENCE_DISCLAIMER,
  type ServiceInfo,
  type BucketInfo,
} from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

const SERVICE_COLUMNS: Column<ServiceInfo>[] = [
  { key: "name", header: "service", mono: true, width: "24%" },
  { key: "role", header: "role" },
  { key: "port", header: "port", mono: true, width: "90px" },
  { key: "exposure", header: "exposure", width: "24%" },
];

const BUCKET_COLUMNS: Column<BucketInfo>[] = [
  { key: "name", header: "bucket", mono: true, width: "24%" },
  {
    key: "kind",
    header: "kind",
    width: "120px",
    render: (b) => <Badge>{b.kind}</Badge>,
  },
  { key: "privacy", header: "privacy", width: "20%" },
  { key: "note", header: "notes" },
];

export default async function InfrastructurePage() {
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;

  return (
    <>
      <Guide id="integrations.infrastructure.page">
        <PageHeader
          eyebrow="Infrastructure"
          title="Architecture"
        />
      </Guide>

      <Guide id="integrations.infrastructure.reference-note">
        <p className="ref-note" style={{ marginBottom: "18px" }}>
          <Badge>reference</Badge>
          <span>{REFERENCE_DISCLAIMER}</span>
        </p>
      </Guide>

      <div className="stack">
        <Section eyebrow="Compute" title="Services">
          <Guide id="integrations.infrastructure.services">
            <DataTable
              columns={SERVICE_COLUMNS}
              rows={SERVICES}
              getRowKey={(s) => s.name}
            />
          </Guide>
          <p className="note">{NOT_ENABLED}</p>
        </Section>

        <Section eyebrow="Storage" title="Buckets">
          <Guide id="integrations.infrastructure.buckets">
            <DataTable
              columns={BUCKET_COLUMNS}
              rows={BUCKETS}
              getRowKey={(b) => b.name}
            />
          </Guide>
        </Section>

        <Section eyebrow="Security" title="Posture">
          <Guide id="integrations.infrastructure.security">
            <RefList items={SECURITY_POSTURE} />
          </Guide>
        </Section>

        <div className="split-2">
          <Section eyebrow="Resilience" title="Backups & DR">
            <Guide id="integrations.infrastructure.backups">
              <RefList items={BACKUPS_DR} />
            </Guide>
          </Section>
          <Section eyebrow="Telemetry" title="Observability">
            <Guide id="integrations.infrastructure.observability">
              <RefList items={OBSERVABILITY} />
            </Guide>
          </Section>
        </div>

        <Section eyebrow="Network" title="Topology">
          <Guide id="integrations.infrastructure.network">
            <RefList items={NETWORK} />
          </Guide>
        </Section>
      </div>
    </>
  );
}
