import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BisonApiError,
  bustConnectionCache,
  isProvisioned,
  listCampaigns,
  normalizeBaseUrl,
  readConnection,
  validateConnection,
  writeConnection,
  type SecretsInvoker,
} from "./bison";
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ARN =
  "arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/emailbison-AbCdEf";

/** Fake Secrets Manager holding one JSON string. */
function fakeSecrets(initial: string | undefined): {
  invoker: SecretsInvoker;
  puts: string[];
  gets: () => number;
} {
  let value = initial;
  const puts: string[] = [];
  let gets = 0;
  return {
    invoker: {
      send: (cmd: unknown) => {
        if (cmd instanceof GetSecretValueCommand) {
          gets += 1;
          return Promise.resolve({ SecretString: value });
        }
        if (cmd instanceof PutSecretValueCommand) {
          value = cmd.input.SecretString ?? undefined;
          puts.push(value ?? "");
          return Promise.resolve({});
        }
        return Promise.reject(new Error("unexpected command"));
      },
    },
    puts,
    gets: () => gets,
  };
}

const CONNECTED = JSON.stringify({
  base_url: "https://dedi.emailbison.com",
  api_key: "9|abc",
  workspace_name: "Nsight",
});

/** One campaigns page as the real API shapes it (verified via OpenAPI spec). */
const CAMPAIGNS_BODY = {
  data: [
    {
      id: 7,
      uuid: "u-7",
      name: "August outreach",
      status: "Active",
      emails_sent: 120,
      opened: 44,
      unique_opens: 30,
      replied: 9,
      unique_replies: 8,
      bounced: 2,
      unsubscribed: 1,
      interested: 4,
      total_leads: 300,
      total_leads_contacted: 120,
      updated_at: "2026-08-13T10:00:00.000000Z",
    },
  ],
  meta: { current_page: 2, last_page: 5, total: 63, per_page: 15 },
};

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.EMAILBISON_SECRET_ARN = ARN;
  bustConnectionCache();
});
afterEach(() => {
  delete process.env.EMAILBISON_SECRET_ARN;
  bustConnectionCache();
});

describe("normalizeBaseUrl", () => {
  it("accepts a bare host and returns an https origin", () => {
    expect(normalizeBaseUrl("dedi.emailbison.com")).toBe(
      "https://dedi.emailbison.com",
    );
  });
  it("strips pasted paths (including /api) down to the origin", () => {
    expect(normalizeBaseUrl("https://dedi.emailbison.com/api/")).toBe(
      "https://dedi.emailbison.com",
    );
  });
  it("rejects http, garbage, and dotless hosts", () => {
    expect(normalizeBaseUrl("http://dedi.emailbison.com")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("localhost")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });
});

describe("connection secret", () => {
  it("isProvisioned reflects the env wiring", () => {
    expect(isProvisioned()).toBe(true);
    delete process.env.EMAILBISON_SECRET_ARN;
    expect(isProvisioned()).toBe(false);
  });

  it("reads a stored connection", async () => {
    const { invoker } = fakeSecrets(CONNECTED);
    const conn = await readConnection(invoker, { fresh: true });
    expect(conn).toEqual({
      baseUrl: "https://dedi.emailbison.com",
      apiKey: "9|abc",
      workspaceName: "Nsight",
    });
  });

  it("returns null when unprovisioned, blank, or unparseable", async () => {
    delete process.env.EMAILBISON_SECRET_ARN;
    expect(await readConnection(fakeSecrets(CONNECTED).invoker)).toBeNull();
    process.env.EMAILBISON_SECRET_ARN = ARN;
    const blank = fakeSecrets(
      JSON.stringify({ base_url: "", api_key: "", workspace_name: "" }),
    );
    expect(await readConnection(blank.invoker, { fresh: true })).toBeNull();
    const garbage = fakeSecrets("{not json");
    expect(await readConnection(garbage.invoker, { fresh: true })).toBeNull();
  });

  it("caches reads for the TTL; fresh bypasses; writes bust", async () => {
    const store = fakeSecrets(CONNECTED);
    await readConnection(store.invoker, { fresh: true });
    await readConnection(store.invoker);
    expect(store.gets()).toBe(1);
    await readConnection(store.invoker, { fresh: true });
    expect(store.gets()).toBe(2);
    await writeConnection(null, store.invoker);
    await readConnection(store.invoker);
    expect(store.gets()).toBe(3);
  });

  it("writeConnection persists JSON and disconnect blanks it", async () => {
    const store = fakeSecrets(undefined);
    await writeConnection(
      { baseUrl: "https://x.example.com", apiKey: "k", workspaceName: "W" },
      store.invoker,
    );
    expect(JSON.parse(store.puts[0])).toEqual({
      base_url: "https://x.example.com",
      api_key: "k",
      workspace_name: "W",
    });
    await writeConnection(null, store.invoker);
    expect(JSON.parse(store.puts[1])).toEqual({
      base_url: "",
      api_key: "",
      workspace_name: "",
    });
  });

  it("writeConnection throws when the secret is not provisioned", async () => {
    delete process.env.EMAILBISON_SECRET_ARN;
    await expect(
      writeConnection(null, fakeSecrets(undefined).invoker),
    ).rejects.toThrow(/not provisioned/);
  });
});

const CONN = { baseUrl: "https://dedi.emailbison.com", apiKey: "9|abc" };

describe("listCampaigns", () => {
  it("maps the real response shape and carries pagination meta", async () => {
    const fetchImpl = vi.fn(async () => okJson(CAMPAIGNS_BODY));
    const { campaigns, meta } = await listCampaigns(CONN, {
      status: "active",
      page: 2,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://dedi.emailbison.com/api/campaigns?page=2&status=active");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 9|abc",
    );
    expect(campaigns).toEqual([
      {
        id: 7,
        uuid: "u-7",
        name: "August outreach",
        status: "Active",
        emailsSent: 120,
        uniqueOpens: 30,
        uniqueReplies: 8,
        bounced: 2,
        unsubscribed: 1,
        interested: 4,
        totalLeads: 300,
        updatedAt: "2026-08-13T10:00:00.000000Z",
      },
    ]);
    expect(meta).toEqual({ currentPage: 2, lastPage: 5, total: 63 });
  });

  it("maps 401 to a token-rejected BisonApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(listCampaigns(CONN, { fetchImpl })).rejects.toThrow(
      /rejected the API token/,
    );
    await expect(listCampaigns(CONN, { fetchImpl })).rejects.toBeInstanceOf(
      BisonApiError,
    );
  });

  it("maps network failure to a reachability BisonApiError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(listCampaigns(CONN, { fetchImpl })).rejects.toThrow(
      /unreachable/,
    );
  });
});

describe("validateConnection", () => {
  it("proves the token via campaigns, then best-efforts the workspace name", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/api/workspaces/v1.1")
        ? okJson({ data: [{ id: 1, name: "Nsight", current: true }] })
        : okJson(CAMPAIGNS_BODY),
    );
    expect(await validateConnection(CONN, fetchImpl)).toEqual({
      workspaceName: "Nsight",
    });
  });

  it("workspace lookup failure is non-fatal (null name)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/api/workspaces/v1.1")
        ? new Response("nope", { status: 500 })
        : okJson(CAMPAIGNS_BODY),
    );
    expect(await validateConnection(CONN, fetchImpl)).toEqual({
      workspaceName: null,
    });
  });

  it("a bad token fails validation outright", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(validateConnection(CONN, fetchImpl)).rejects.toBeInstanceOf(
      BisonApiError,
    );
  });
});
