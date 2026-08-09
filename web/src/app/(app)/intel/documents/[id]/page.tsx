import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { DocumentDetail } from "@/components/intel/DocumentDetail";
import { getEmbeddingProviderInfo } from "../../provider-info";

// Request-time identity + live embedding status; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Intel Document · MarketingHub",
};

/**
 * One pasted document: content plus its chunk/embedding lifecycle. Pending
 * documents say plainly that they're waiting on the worker's queue drain;
 * stub-embedded corpora are labeled via the provider badge.
 */
export default async function IntelDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireMarketingUser();
  const { id } = await params;
  const provider = getEmbeddingProviderInfo();

  return (
    <>
      <PageHeader title="Document" />
      <DocumentDetail documentId={id} provider={provider} />
    </>
  );
}
