import { describe, expect, test } from "vitest";
import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { EMBEDDING_DIMS } from "./schema";
import {
  BedrockTitanProvider,
  DEFAULT_BEDROCK_MODEL_ID,
  EMBED_PROVIDERS,
  EmbeddingConfigError,
  EmbeddingProviderError,
  STUB_MODEL_ID,
  StubProvider,
  providerFromEnv,
  type BedrockInvoker,
  type EmbeddingProvider,
} from "./providers";

/** Titan-shaped request body the provider must send. */
interface TitanRequestBody {
  inputText: string;
  dimensions: number;
  normalize: boolean;
}

/** Deterministic fake vector so parity tests are stable. */
function fakeVector(text: string, dims = EMBEDDING_DIMS): number[] {
  return Array.from({ length: dims }, (_, i) => ((text.length + i) % 17) / 17);
}

/** Records every InvokeModel request; responds via the injected function. */
class FakeBedrockClient implements BedrockInvoker {
  readonly modelIds: string[] = [];
  readonly requests: TitanRequestBody[] = [];

  constructor(
    private readonly respond: (body: TitanRequestBody) => unknown = (body) => ({
      embedding: fakeVector(body.inputText),
      inputTextTokenCount: 5,
    }),
  ) {}

  async send(command: InvokeModelCommand): Promise<{ body?: Uint8Array }> {
    this.modelIds.push(String(command.input.modelId));
    const body = JSON.parse(String(command.input.body)) as TitanRequestBody;
    this.requests.push(body);
    const payload = this.respond(body);
    if (payload === undefined) return { body: undefined };
    return { body: new TextEncoder().encode(JSON.stringify(payload)) };
  }
}

describe("StubProvider", () => {
  const stub = new StubProvider();

  test("is dims-matched to the vector(1024) column", () => {
    expect(stub.dims).toBe(EMBEDDING_DIMS);
    expect(stub.dims).toBe(1024);
    expect(stub.model).toBe(STUB_MODEL_ID);
  });

  test("is deterministic: identical text embeds identically", async () => {
    const [a] = await stub.embed(["competitor pricing"]);
    const [b] = await stub.embed(["competitor pricing"]);
    expect(a).toEqual(b);
  });

  test("distinct texts embed differently", async () => {
    const [a, b] = await stub.embed(["alpha", "beta"]);
    expect(a).not.toEqual(b);
  });

  test("vectors are L2-normalized (cosine-ready)", async () => {
    for (const [vector] of [
      await stub.embed(["x"]),
      await stub.embed(["a much longer competitor-intel paragraph"]),
    ]) {
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  test("returns one vector per input, in order", async () => {
    const vectors = await stub.embed(["one", "two", "three"]);
    expect(vectors).toHaveLength(3);
    expect(vectors[1]).toEqual((await stub.embed(["two"]))[0]);
  });
});

describe("BedrockTitanProvider", () => {
  test("sends the Titan V2 request shape, one call per text, in order", async () => {
    const client = new FakeBedrockClient();
    const provider = new BedrockTitanProvider({ client });
    const vectors = await provider.embed(["first text", "second text"]);

    expect(vectors).toHaveLength(2);
    expect(client.requests).toEqual([
      { inputText: "first text", dimensions: 1024, normalize: true },
      { inputText: "second text", dimensions: 1024, normalize: true },
    ]);
    expect(client.modelIds).toEqual([
      DEFAULT_BEDROCK_MODEL_ID,
      DEFAULT_BEDROCK_MODEL_ID,
    ]);
  });

  test("defaults to Titan V2 and honors a model override", () => {
    expect(new BedrockTitanProvider({ client: new FakeBedrockClient() }).model)
      .toBe("amazon.titan-embed-text-v2:0");
    const custom = new BedrockTitanProvider({
      client: new FakeBedrockClient(),
      modelId: "cohere.embed-english-v3",
    });
    expect(custom.model).toBe("cohere.embed-english-v3");
  });

  test("throws a typed error on a missing embedding", async () => {
    const provider = new BedrockTitanProvider({
      client: new FakeBedrockClient(() => ({ inputTextTokenCount: 5 })),
    });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  });

  test("throws a typed error on wrong dimensions", async () => {
    const provider = new BedrockTitanProvider({
      client: new FakeBedrockClient((body) => ({
        embedding: fakeVector(body.inputText, 8),
      })),
    });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  });

  test("wraps SDK invocation failures (throttling, access denied, timeouts) in the typed provider error", async () => {
    const throttled = new Error("Too many requests, please wait");
    throttled.name = "ThrottlingException";
    const provider = new BedrockTitanProvider({
      client: {
        send: async () => {
          throw throttled;
        },
      },
    });
    let caught: unknown;
    try {
      await provider.embed(["x"]);
    } catch (error) {
      caught = error;
    }
    // Typed so the search route maps it to its honest 502 degraded state
    // instead of an opaque 500; message carries the SDK error name.
    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as Error).message).toContain("ThrottlingException");
  });

  test("throws a typed error on non-numeric entries or empty bodies", async () => {
    const nonNumeric = new BedrockTitanProvider({
      client: new FakeBedrockClient(() => ({
        embedding: new Array(EMBEDDING_DIMS).fill("nope"),
      })),
    });
    await expect(nonNumeric.embed(["x"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );

    const empty = new BedrockTitanProvider({
      client: new FakeBedrockClient(() => undefined),
    });
    await expect(empty.embed(["x"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  });
});

describe("provider parity", () => {
  const providers: Array<[string, EmbeddingProvider]> = [
    ["stub", new StubProvider()],
    ["bedrock", new BedrockTitanProvider({ client: new FakeBedrockClient() })],
  ];

  test.each(providers)(
    "%s: dims match the schema and embed() returns number[texts][dims]",
    async (_name, provider) => {
      expect(provider.dims).toBe(EMBEDDING_DIMS);
      expect(provider.model.length).toBeGreaterThan(0);
      const vectors = await provider.embed(["alpha", "beta"]);
      expect(vectors).toHaveLength(2);
      for (const vector of vectors) {
        expect(vector).toHaveLength(provider.dims);
        expect(vector.every((v) => Number.isFinite(v))).toBe(true);
      }
    },
  );

  test("both providers report the same dims", () => {
    const [[, a], [, b]] = providers;
    expect(a.dims).toBe(b.dims);
  });
});

describe("providerFromEnv", () => {
  test("defaults to the stub when unset or blank (inert-safe)", () => {
    expect(providerFromEnv({})).toBeInstanceOf(StubProvider);
    expect(providerFromEnv({ CI_EMBED_PROVIDER: "" })).toBeInstanceOf(
      StubProvider,
    );
    expect(providerFromEnv({ CI_EMBED_PROVIDER: "  " })).toBeInstanceOf(
      StubProvider,
    );
  });

  test("selects providers case-insensitively", () => {
    expect(providerFromEnv({ CI_EMBED_PROVIDER: "stub" })).toBeInstanceOf(
      StubProvider,
    );
    expect(providerFromEnv({ CI_EMBED_PROVIDER: "Bedrock" })).toBeInstanceOf(
      BedrockTitanProvider,
    );
  });

  test("bedrock uses Titan V2 unless CI_EMBED_MODEL_ID overrides it", () => {
    expect(
      providerFromEnv({ CI_EMBED_PROVIDER: "bedrock" }).model,
    ).toBe(DEFAULT_BEDROCK_MODEL_ID);
    expect(
      providerFromEnv({
        CI_EMBED_PROVIDER: "bedrock",
        CI_EMBED_MODEL_ID: "cohere.embed-english-v3",
      }).model,
    ).toBe("cohere.embed-english-v3");
  });

  test("memoizes per (provider, model, region) — no fresh client per request", () => {
    // Search calls providerFromEnv per request; without the memo every
    // flag-ON request would build a new BedrockRuntimeClient (fresh
    // credential resolution + TLS session).
    expect(providerFromEnv({})).toBe(providerFromEnv({}));
    const bedrockEnv = { CI_EMBED_PROVIDER: "bedrock" };
    expect(providerFromEnv(bedrockEnv)).toBe(providerFromEnv(bedrockEnv));
    // A different model/region is a different cache entry, never a stale hit.
    expect(
      providerFromEnv({
        CI_EMBED_PROVIDER: "bedrock",
        CI_EMBED_MODEL_ID: "cohere.embed-english-v3",
      }),
    ).not.toBe(providerFromEnv(bedrockEnv));
  });

  test("misconfiguration throws a typed EmbeddingConfigError, not a crash", () => {
    let caught: unknown;
    try {
      providerFromEnv({ CI_EMBED_PROVIDER: "openai" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddingConfigError);
    expect((caught as Error).message).toContain("CI_EMBED_PROVIDER");
    expect((caught as Error).message).toContain(EMBED_PROVIDERS.join(", "));
  });
});
