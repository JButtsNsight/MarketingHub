import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { RagAnswerPanel } from "@/components/intel/RagAnswerPanel";
import { SearchPanel } from "@/components/intel/SearchPanel";
import { getEmbeddingProviderInfo } from "../provider-info";

// Request-time identity; every search embeds the query live. Never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Intel Search · MarketingHub",
};

/**
 * Semantic search over the competitor-intel corpus (q lives in the URL, so
 * searches are shareable). Retrieval only — the answer panel states plainly
 * that synthesis is pending sign-off and makes no LLM calls.
 */
export default async function IntelSearchPage() {
  await requireMarketingUser();
  const provider = getEmbeddingProviderInfo();

  return (
    <>
      <PageHeader title="Intel Search" />
      <div className="stack">
        <SearchPanel provider={provider} />
        <RagAnswerPanel />
      </div>
    </>
  );
}
