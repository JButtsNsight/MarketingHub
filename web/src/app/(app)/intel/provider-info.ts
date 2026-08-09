// Server-side snapshot of the embedding provider for the intel pages.
// Reads the same env the API routes and worker use (foundation
// providerFromEnv), so the badges the UI shows match what a search will
// actually do. A misconfigured CI_EMBED_PROVIDER becomes an honest 'invalid'
// state — the page renders a visible warning instead of crashing.

import {
  EmbeddingConfigError,
  providerFromEnv,
  StubProvider,
} from "@/lib/intel/providers";
import type { EmbeddingProviderInfo } from "@/components/intel/types";

export function getEmbeddingProviderInfo(): EmbeddingProviderInfo {
  try {
    const provider = providerFromEnv();
    const stub = provider instanceof StubProvider;
    return {
      provider: stub ? "stub" : "bedrock",
      model: provider.model,
      stub,
    };
  } catch (err) {
    if (err instanceof EmbeddingConfigError) {
      return { provider: "invalid", model: null, stub: false, detail: err.message };
    }
    throw err;
  }
}
