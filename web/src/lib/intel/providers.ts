import "server-only";

// Embedding provider abstraction for competitor-intel RAG (Wave 8).
//
// Server/worker only: this module holds the AWS SDK client and reads env, so
// it must never be imported from client components. (The worker bundle
// aliases `server-only` to a no-op shim — see build:worker.) The pure types
// live in ./schema; supabase/functions/embed is superseded by this module.
//
// Selection is env-driven and STAGED: CI_EMBED_PROVIDER defaults to 'stub'
// (deterministic, zero AWS calls) so the shipped default is inert-safe; the
// staged infra flag flips it to 'bedrock' alongside the IAM grant. Both
// providers emit 1024-dim unit-ish vectors so cosine search behaves the same
// shape-wise either way; chunks record `embedding_model` so search can warn
// on corpus/query provider mismatch.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { EMBEDDING_DIMS } from "./schema";

/** Titan Text Embeddings V2 — 1024 dims by default, normalize=true default. */
export const DEFAULT_BEDROCK_MODEL_ID = "amazon.titan-embed-text-v2:0";

/** Bedrock region is pinned — the staged IAM ARN is us-east-1 scoped. */
export const DEFAULT_BEDROCK_REGION = "us-east-1";

/**
 * Hard client-side deadlines on every InvokeModel call. The smithy default is
 * 0 (= NO timeout): one black-holed HTTPS request (PrivateLink outage,
 * network partition) would otherwise hang `embed()` forever — wedging the
 * worker consumer's busy flag permanently and keeping the ref'd socket alive
 * past SIGTERM until ECS SIGKILLs the task. Titan embedding calls complete in
 * well under a second; these bounds are generous.
 */
export const BEDROCK_CONNECTION_TIMEOUT_MS = 5_000;
export const BEDROCK_REQUEST_TIMEOUT_MS = 30_000;

/** Recorded in `chunks.embedding_model` for stub-embedded corpora. */
export const STUB_MODEL_ID = "stub-djb2-1024";

/** Valid CI_EMBED_PROVIDER values. */
export const EMBED_PROVIDERS = ["stub", "bedrock"] as const;
export type EmbedProviderName = (typeof EMBED_PROVIDERS)[number];

/** A batch text-embedding backend. `embed` preserves input order. */
export interface EmbeddingProvider {
  /** Vector width — always {@link EMBEDDING_DIMS} to match `vector(1024)`. */
  readonly dims: number;
  /** Model identifier recorded alongside every embedded chunk. */
  readonly model: string;
  /** One vector (length `dims`) per input text, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * The embedding configuration is invalid (unrecognized CI_EMBED_PROVIDER).
 * Callers map this to an honest degraded state — never a crash loop.
 */
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

/** The provider backend returned an unusable response (bad shape/dims). */
export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

/**
 * Deterministic per-dim djb2-xor embedding mapped to [-1, 1], then
 * L2-normalized (Titan normalize=true parity, keeps cosine meaningful).
 * Same hash family as supabase/functions/embed, widened to 1024 dims.
 */
function stubEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS);
  let normSquared = 0;
  for (let dim = 0; dim < EMBEDDING_DIMS; dim++) {
    let h = 5381 + dim * 33;
    for (let i = 0; i < text.length; i++) {
      h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    const value = (h / 0xffffffff) * 2 - 1;
    vector[dim] = value;
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (norm === 0) return vector; // unreachable: dim seeds are non-zero
  for (let dim = 0; dim < EMBEDDING_DIMS; dim++) {
    vector[dim] = vector[dim] / norm;
  }
  return vector;
}

/**
 * Deterministic, dependency-free stub: identical text always embeds
 * identically, so RAG plumbing (queue → chunks → match_chunks → UI) is fully
 * exercisable with zero AWS calls. Similarity is illustrative only — the UI
 * badges stub corpora accordingly.
 */
export class StubProvider implements EmbeddingProvider {
  readonly dims = EMBEDDING_DIMS;
  readonly model = STUB_MODEL_ID;

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(stubEmbedding(text));
      // Yield the event loop between chunks. stubEmbedding is O(dims × len)
      // synchronous CPU (~2M char ops per max-size chunk); a max-size
      // document is ~350 chunks, which as one uninterrupted `texts.map`
      // would block the SHARED worker process (0.25 vCPU) for seconds per
      // document — starving the sacred SMS dispatcher's timers and in-flight
      // I/O. A macrotask yield per chunk caps every block at one chunk
      // (~ms-scale) so dispatch latency is unaffected by embedding backlogs.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return vectors;
  }
}

/** Minimal client surface — lets tests inject a fake without the real SDK. */
export interface BedrockInvoker {
  send(command: InvokeModelCommand): Promise<{ body?: Uint8Array }>;
}

export interface BedrockTitanOptions {
  /** Defaults to {@link DEFAULT_BEDROCK_MODEL_ID}. */
  modelId?: string;
  /** Defaults to {@link DEFAULT_BEDROCK_REGION}. */
  region?: string;
  /** Test seam; defaults to a real BedrockRuntimeClient. */
  client?: BedrockInvoker;
}

/**
 * Amazon Titan Text Embeddings V2 via Bedrock InvokeModel. One request per
 * text, sequentially — batches are small (worker BATCH default 5 documents)
 * and sequential keeps throughput/pricing behavior predictable. Requires the
 * staged IAM grant (enableBedrockEmbeddings); constructing it is side-effect
 * free.
 */
export class BedrockTitanProvider implements EmbeddingProvider {
  readonly dims = EMBEDDING_DIMS;
  readonly model: string;
  private readonly client: BedrockInvoker;

  constructor(options: BedrockTitanOptions = {}) {
    this.model = options.modelId?.trim() || DEFAULT_BEDROCK_MODEL_ID;
    this.client =
      options.client ??
      (new BedrockRuntimeClient({
        region: options.region?.trim() || DEFAULT_BEDROCK_REGION,
        // Plain-options form: the SDK builds a NodeHttpHandler from these.
        // Never omit — the default timeouts are 0 (= none) and a hung
        // request would wedge the consumer forever (see the constants).
        requestHandler: {
          connectionTimeout: BEDROCK_CONNECTION_TIMEOUT_MS,
          requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS,
        },
      }) as unknown as BedrockInvoker);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.invokeOne(text));
    }
    return vectors;
  }

  private async invokeOne(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMS,
        normalize: true,
      }),
    });
    let response: { body?: Uint8Array };
    try {
      response = await this.client.send(command);
    } catch (err) {
      // Wrap EVERY SDK failure (throttling, access denied, expired creds,
      // network timeout) in the typed provider error so the search route can
      // map it to its honest 502 "embedding-failed" degraded state instead
      // of an opaque 500. Message carries the SDK error name/message only —
      // never credentials or request payloads.
      const name = err instanceof Error ? err.name : "Error";
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmbeddingProviderError(
        `[intel] embed failed: ${this.model} invoke error (${name}): ${detail}`,
      );
    }
    if (!response.body) {
      throw new EmbeddingProviderError(
        `[intel] embed failed: ${this.model} returned an empty response body`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new EmbeddingProviderError(
        `[intel] embed failed: ${this.model} returned non-JSON response body`,
      );
    }
    const embedding = (parsed as { embedding?: unknown }).embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== this.dims ||
      !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new EmbeddingProviderError(
        `[intel] embed failed: ${this.model} returned an invalid embedding ` +
          `(expected number[${this.dims}])`,
      );
    }
    return embedding as number[];
  }
}

/**
 * Module-level memo keyed by the env values that shape the provider. Both
 * providers are stateless per-call, so sharing one instance per config is
 * safe — and for Bedrock it is the point: without it every /api/intel/search
 * request would construct a fresh BedrockRuntimeClient (fresh task-role
 * credential resolution + TLS session) the way an unmemoized getServiceClient
 * would. Config errors are never cached — a bad value re-throws per call.
 */
const providerCache = new Map<string, EmbeddingProvider>();

/**
 * Build the provider from env. Default (unset/blank CI_EMBED_PROVIDER) is the
 * stub — zero AWS calls until the staged activation flips the env. An
 * unrecognized value throws {@link EmbeddingConfigError} (typed, catchable)
 * rather than crashing the process. Instances are memoized per
 * (provider, model id, region) — see {@link providerCache}.
 *
 * Env: CI_EMBED_PROVIDER ('stub' | 'bedrock', case-insensitive),
 * CI_EMBED_MODEL_ID (bedrock model override), AWS_REGION/AWS_DEFAULT_REGION.
 */
export function providerFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const raw = (env.CI_EMBED_PROVIDER ?? "").trim();
  const name = raw === "" ? "stub" : raw.toLowerCase();
  if (name !== "stub" && name !== "bedrock") {
    throw new EmbeddingConfigError(
      `CI_EMBED_PROVIDER must be one of: ${EMBED_PROVIDERS.join(", ")} (got "${raw}")`,
    );
  }

  const modelId = env.CI_EMBED_MODEL_ID?.trim() ?? "";
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "").trim();
  const key = `${name}|${modelId}|${region}`;
  const cached = providerCache.get(key);
  if (cached) return cached;

  const provider =
    name === "stub"
      ? new StubProvider()
      : new BedrockTitanProvider({
          modelId: env.CI_EMBED_MODEL_ID,
          region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
        });
  providerCache.set(key, provider);
  return provider;
}
