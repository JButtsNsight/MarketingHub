// Embedding-provider badge — server-safe and presentational. Labels stub mode
// plainly (contract honesty rule), names the real model when Bedrock is on,
// and surfaces a misconfigured CI_EMBED_PROVIDER as a visible warning rather
// than hiding it.

import { Badge } from "@/components/ui/Badge";
import { STUB_BADGE_TEXT } from "./status";
import type { EmbeddingProviderInfo } from "./types";

export function ProviderBadge({ info }: { info: EmbeddingProviderInfo }) {
  if (info.provider === "invalid") {
    return (
      <span className="form-error" role="alert">
        Embedding provider misconfigured
        {info.detail ? ` — ${info.detail}` : ""}. Search is unavailable until
        CI_EMBED_PROVIDER is corrected.
      </span>
    );
  }
  if (info.stub) {
    return (
      <Badge tone="var(--warn)" title={`model: ${info.model ?? "unknown"}`}>
        {STUB_BADGE_TEXT}
      </Badge>
    );
  }
  return (
    <Badge tone="var(--ok)" title="AWS Bedrock embeddings enabled">
      Bedrock embeddings · {info.model}
    </Badge>
  );
}

export default ProviderBadge;
