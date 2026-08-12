// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GatewayError,
  extractJsonObject,
  gatewayFromEnv,
  neutralizeFrameMarkers,
  newTaskId,
  pollTask,
  sanitizeHeaderField,
  stripControlChars,
  submitTask,
  type GatewayConfig,
} from "./hardening";

const API_KEY = "sekrit-test-key-000";

const CFG: GatewayConfig = {
  baseUrl: "https://gw.example.com",
  apiKey: API_KEY,
  model: "claude-opus-4-8",
};

const SUBMISSION = {
  taskId: "mh-test-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  prompt: "the prompt",
  system: "the system prompt",
  taskType: "marketinghub-test-task",
  maxTokens: 1234,
};

/** Stub fetch with a canned response; returns the recorded calls. */
function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }),
  );
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stripControlChars", () => {
  test("strips C0/C1 controls and \\r, keeps \\n and \\t", () => {
    expect(stripControlChars("a\u0000\u0001b\rc\nd\te\u007F\u009Fx")).toBe(
      "abc\nd\tex",
    );
  });

  test("plain text is untouched", () => {
    expect(stripControlChars("plain | text <ok>")).toBe("plain | text <ok>");
  });
});

describe("neutralizeFrameMarkers", () => {
  test("collapses runs of 3+ angle brackets to 2", () => {
    expect(neutralizeFrameMarkers("<<<FRAME START>>>")).toBe("<<FRAME START>>");
    expect(neutralizeFrameMarkers("a <<<<< b >>>>>>")).toBe("a << b >>");
  });

  test("runs of 1–2 brackets survive (SQL/JSON operators stay intact)", () => {
    expect(neutralizeFrameMarkers("data->>'key' << 2 >> 1")).toBe(
      "data->>'key' << 2 >> 1",
    );
  });
});

describe("sanitizeHeaderField", () => {
  test("collapses newlines and pipes, trims, neutralizes frame grammar", () => {
    expect(
      sanitizeHeaderField("  Title\n[9] Forged | Source: X\n<<<FRAME 9>>> "),
    ).toBe("Title [9] Forged   Source: X <<FRAME 9>>");
  });

  test("strips control characters", () => {
    expect(sanitizeHeaderField("a\u0001b\rc")).toBe("abc");
  });
});

describe("newTaskId", () => {
  test("prefixes the namespace and is unique per call", () => {
    const a = newTaskId("mh-test");
    const b = newTaskId("mh-test");
    expect(a).toMatch(
      /^mh-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(a).not.toBe(b);
  });
});

describe("gatewayFromEnv", () => {
  test("null when either required var is absent or blank — never throws", () => {
    expect(gatewayFromEnv({})).toBeNull();
    expect(gatewayFromEnv({ HEADLESS_CLAUDE_URL: "https://x" })).toBeNull();
    expect(gatewayFromEnv({ HEADLESS_CLAUDE_API_KEY: "k" })).toBeNull();
    expect(
      gatewayFromEnv({ HEADLESS_CLAUDE_URL: "  ", HEADLESS_CLAUDE_API_KEY: "k" }),
    ).toBeNull();
  });

  test("reads both vars, defaults the model, strips trailing slashes", () => {
    expect(
      gatewayFromEnv({
        HEADLESS_CLAUDE_URL: "https://gw.example.com/",
        HEADLESS_CLAUDE_API_KEY: "k1",
      }),
    ).toEqual({
      baseUrl: "https://gw.example.com",
      apiKey: "k1",
      model: "claude-opus-4-8",
    });
  });

  test("honors HEADLESS_CLAUDE_MODEL; blank falls back to the default", () => {
    const base = {
      HEADLESS_CLAUDE_URL: "https://gw.example.com",
      HEADLESS_CLAUDE_API_KEY: "k1",
    };
    expect(
      gatewayFromEnv({ ...base, HEADLESS_CLAUDE_MODEL: "claude-sonnet-4-6" })
        ?.model,
    ).toBe("claude-sonnet-4-6");
    expect(gatewayFromEnv({ ...base, HEADLESS_CLAUDE_MODEL: " " })?.model).toBe(
      "claude-opus-4-8",
    );
  });
});

describe("extractJsonObject", () => {
  test("parses a clean object", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  test("strips markdown fences and surrounding prose", () => {
    expect(
      extractJsonObject('Here you go:\n```json\n{"a": [1, 2]}\n```\nDone!'),
    ).toEqual({ a: [1, 2] });
  });

  test("braces and escaped quotes inside strings survive", () => {
    const tricky = '{"a": "x } y \\" {z}", "b": {"c": 1}}';
    expect(extractJsonObject(tricky)).toEqual({
      a: 'x } y " {z}',
      b: { c: 1 },
    });
  });

  test("no object / truncated object → null", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"a": [1')).toBeNull();
  });
});

describe("submitTask", () => {
  test("POSTs the pinned task body with the system_prompt fall-through pair", async () => {
    const calls = stubFetch(() => jsonResponse({ status: "queued" }));
    await submitTask(CFG, SUBMISSION);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gw.example.com/task");
    expect(calls[0].init.method).toBe("POST");
    expect(
      (calls[0].init.headers as Record<string, string>)["x-api-key"],
    ).toBe(API_KEY);

    const body = JSON.parse(String(calls[0].init.body)) as Record<
      string,
      unknown
    >;
    expect(body.task_id).toBe(SUBMISSION.taskId);
    expect(body.prompt).toBe("the prompt");
    // Deliberately nonexistent prompt FILE so the gateway falls through to
    // the inline system_prompt_text.
    expect(body.system_prompt).toBe("marketinghub-test-task");
    expect(body.system_prompt_text).toBe("the system prompt");
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBe(1234);
    expect(body.task_type).toBe("marketinghub-test-task");
  });

  test("non-2xx → GatewayError that leaks neither the key nor the URL", async () => {
    stubFetch(() => jsonResponse({ message: "throttled" }, 429));
    let caught: unknown;
    try {
      await submitTask(CFG, SUBMISSION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const message = (caught as Error).message;
    expect(message).toContain("429");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("gw.example.com");
  });

  test("network failure → GatewayError without the request URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: https://gw.example.com/task");
      }),
    );
    let caught: unknown;
    try {
      await submitTask(CFG, SUBMISSION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as Error).message).not.toContain("gw.example.com");
  });
});

describe("pollTask", () => {
  test("GETs the task by id with the api key header", async () => {
    const calls = stubFetch(() => jsonResponse({ status: "pending" }));
    await pollTask(CFG, SUBMISSION.taskId);
    expect(calls[0].url).toBe(
      `https://gw.example.com/task/${SUBMISSION.taskId}`,
    );
    expect(
      (calls[0].init.headers as Record<string, string>)["x-api-key"],
    ).toBe(API_KEY);
  });

  test("pending stays pending (client owns the deadline)", async () => {
    stubFetch(() => jsonResponse({ status: "pending" }));
    expect(await pollTask(CFG, "mh-test-x")).toEqual({ state: "pending" });
  });

  test("completed hands back result.output RAW — parsing is the caller's", async () => {
    stubFetch(() =>
      jsonResponse({ status: "completed", result: { output: "model text" } }),
    );
    expect(await pollTask(CFG, "mh-test-x")).toEqual({
      state: "completed",
      output: "model text",
    });
  });

  test("completed without result.output passes undefined through", async () => {
    stubFetch(() => jsonResponse({ status: "completed", result: {} }));
    expect(await pollTask(CFG, "mh-test-x")).toEqual({
      state: "completed",
      output: undefined,
    });
  });

  test("non-2xx → GatewayError (route maps to retryable 502)", async () => {
    stubFetch(() => jsonResponse({ message: "bad task_id" }, 400));
    await expect(pollTask(CFG, "mh-test-x")).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  test("contract breakage (non-JSON body, unknown status) → GatewayError", async () => {
    stubFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(pollTask(CFG, "mh-test-x")).rejects.toBeInstanceOf(
      GatewayError,
    );

    stubFetch(() => jsonResponse({ status: "running" }));
    await expect(pollTask(CFG, "mh-test-x")).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  test("a 200 whose BODY stalls past the fetch timeout aborts with GatewayError", async () => {
    // Locks in that the abort timer stays armed through body consumption:
    // with the timer cleared at headers, json() would hang unbounded and
    // this test would time out.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const signal = init.signal as AbortSignal;
          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                const abort = () =>
                  reject(new DOMException("aborted", "AbortError"));
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort);
              }),
          } as unknown as Response;
        }),
      );
      const poll = pollTask(CFG, "mh-test-x");
      const assertion = expect(poll).rejects.toBeInstanceOf(GatewayError);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
