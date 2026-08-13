// Embedding-provider badge — presentational (guided-mode wraps make it
// client-rendered; today it is only used from the client detail components).
// Labels stub mode plainly (contract honesty rule), names the real model when
// Bedrock is on, and surfaces a misconfigured CI_EMBED_PROVIDER as a visible
// warning rather than hiding it.

import { Badge } from "@/components/ui/Badge";
import { Guide } from "@/components/guide/Guide";
import { STUB_BADGE_TEXT } from "./status";
import type { EmbeddingProviderInfo } from "./types";

export function ProviderBadge({ info }: { info: EmbeddingProviderInfo }) {
  if (info.provider === "invalid") {
    return (
      <Guide id="intel.provider.invalid">
        <span className="form-error" role="alert">
          Embedding provider misconfigured
          {info.detail ? ` — ${info.detail}` : ""}. Search is unavailable until
          CI_EMBED_PROVIDER is corrected.
        </span>
      </Guide>
    );
  }
  if (info.stub) {
    return (
      <Guide id="intel.provider.stub">
        <Badge tone="var(--warn)" title={`model: ${info.model ?? "unknown"}`}>
          {STUB_BADGE_TEXT}
        </Badge>
      </Guide>
    );
  }
  return (
    <Guide id="intel.provider.bedrock">
      <Badge tone="var(--ok)" title="AWS Bedrock embeddings enabled">
        Bedrock embeddings · {info.model}
      </Badge>
    </Guide>
  );
}

export default ProviderBadge;
