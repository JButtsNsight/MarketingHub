import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { PageHeader } from "@/components/ui/PageHeader";
import { Guide } from "@/components/guide/Guide";
import { SourceDetail } from "@/components/intel/SourceDetail";
import { getEmbeddingProviderInfo } from "../../provider-info";

// Request-time identity + live document statuses; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Intel Source · MarketingHub",
};

/**
 * One competitor-intel source: metadata, its documents (with honest
 * chunk/embedding lifecycle states), and paste-text ingestion. The client
 * component loads via /api/intel; the server passes the provider snapshot so
 * stub mode is labeled plainly.
 */
export default async function IntelSourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await requireSectionUser("intel");
  if (!gate.ok) return <Forbidden message="Competitor Intel access required." />;
  const { id } = await params;
  const provider = getEmbeddingProviderInfo();

  return (
    <>
      <Guide id="intel.source.header">
        <PageHeader title="Source" />
      </Guide>
      <SourceDetail sourceId={id} provider={provider} />
    </>
  );
}
