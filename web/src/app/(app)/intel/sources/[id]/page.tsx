import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
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
  await requireMarketingUser();
  const { id } = await params;
  const provider = getEmbeddingProviderInfo();

  return (
    <>
      <PageHeader title="Source" />
      <SourceDetail sourceId={id} provider={provider} />
    </>
  );
}
