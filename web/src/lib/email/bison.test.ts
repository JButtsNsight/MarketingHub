import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BisonApiError,
  bustConnectionCache,
  createCampaign,
  isProvisioned,
  listCampaigns,
  listReplies,
  normalizeBaseUrl,
  pauseCampaign,
  pushLeads,
  readConnection,
  resumeCampaign,
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

describe("pauseCampaign / resumeCampaign", () => {
  it("POSTs the campaign action endpoints, body-less, and tolerates an empty 200", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await pauseCampaign(CONN, 7, fetchImpl);
    await resumeCampaign(CONN, 7, fetchImpl);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://dedi.emailbison.com/api/campaigns/7/pause");
    expect(calls[1][0]).toBe("https://dedi.emailbison.com/api/campaigns/7/resume");
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer 9|abc",
      );
    }
  });

  it("maps 401 to a token-rejected BisonApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(pauseCampaign(CONN, 7, fetchImpl)).rejects.toThrow(
      /rejected the API token/,
    );
    await expect(resumeCampaign(CONN, 7, fetchImpl)).rejects.toBeInstanceOf(
      BisonApiError,
    );
  });
});

describe("createCampaign", () => {
  it("POSTs {name, type:outbound} and maps the created campaign", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ data: { id: 12, name: "September push", status: "Draft" } }),
    );
    const created = await createCampaign(CONN, "September push", fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://dedi.emailbison.com/api/campaigns");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      name: "September push",
      type: "outbound",
    });
    expect(created).toEqual({ id: 12, name: "September push", status: "Draft" });
  });

  it("tolerates an unwrapped campaign object", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ id: 13, name: "Q4 revive", status: "Draft" }),
    );
    expect(await createCampaign(CONN, "Q4 revive", fetchImpl)).toEqual({
      id: 13,
      name: "Q4 revive",
      status: "Draft",
    });
  });
});

/** One replies page as the real API shapes it (verified via OpenAPI spec). */
const REPLIES_BODY = {
  data: [
    {
      id: 31,
      campaign_id: 7,
      from_name: "Dana Reyes",
      from_email_address: "dana@clinic.example.com",
      subject: "Re: August outreach",
      text_body: "Sounds good — send times?",
      html_body: "<p>Sounds good — send times?</p>",
      date_received: "2026-08-13T15:04:05.000000Z",
      folder: "inbox",
      interested: true,
      automated_reply: false,
      read: false,
    },
  ],
  meta: { current_page: 2, last_page: 3, total: 41, per_page: 15 },
};

describe("listReplies", () => {
  it("maps the real response shape, passes filters, and carries meta", async () => {
    const fetchImpl = vi.fn(async () => okJson(REPLIES_BODY));
    const { replies, meta } = await listReplies(CONN, {
      folder: "inbox",
      status: "interested",
      page: 2,
      fetchImpl,
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "https://dedi.emailbison.com/api/replies?page=2&folder=inbox&status=interested",
    );
    expect(replies).toEqual([
      {
        id: 31,
        campaignId: 7,
        fromName: "Dana Reyes",
        fromEmail: "dana@clinic.example.com",
        subject: "Re: August outreach",
        body: "Sounds good — send times?",
        dateReceived: "2026-08-13T15:04:05.000000Z",
        folder: "inbox",
        interested: true,
        read: false,
      },
    ]);
    expect(meta).toEqual({ currentPage: 2, lastPage: 3, total: 41 });
  });

  it("strips html_body to plain text when text_body is absent", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        data: [
          {
            id: 32,
            campaign_id: 7,
            html_body:
              "<html><head><style>p{color:red}</style></head><body>" +
              "<p>Hi <b>Justin</b>,</p><p>Let&#39;s talk &amp; compare notes.</p>" +
              "<script>alert(1)</script></body></html>",
            folder: "inbox",
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      }),
    );
    const { replies } = await listReplies(CONN, { fetchImpl });
    expect(replies[0].body).toBe("Hi Justin,\nLet's talk & compare notes.");
    expect(replies[0].body).not.toMatch(/[<>]/);
    // Absent fields coerce, never crash.
    expect(replies[0].subject).toBe("");
    expect(replies[0].dateReceived).toBeNull();
    expect(replies[0].interested).toBe(false);
  });

  it("maps 401 to a token-rejected BisonApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(listReplies(CONN, { fetchImpl })).rejects.toThrow(
      /rejected the API token/,
    );
  });
});

describe("pushLeads", () => {
  it("attach failure after successful creates reports partial state honestly", async () => {
    let nextId = 1;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/leads/create-or-update/multiple")) {
        return okJson({ data: [{ id: nextId++ }, { id: nextId++ }] });
      }
      return new Response("boom", { status: 500 }); // attach-leads dies
    });
    const err = await (
      await import("./bison")
    )
      .pushLeads(CONN, 7, [{ email: "a@ex.com" }, { email: "b@ex.com" }], fetchImpl)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BisonApiError);
    expect((err as Error).message).toMatch(
      /2 leads were saved to EmailBison but attaching them to the campaign failed/,
    );
    expect((err as Error).message).toMatch(/retrying the push is safe/);
  });


  /** Fake instance: upserts echo ids in order, attach acks with a message. */
  function leadsFetch() {
    let nextId = 1000;
    return vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/leads/create-or-update/multiple")) {
        const body = JSON.parse(init.body as string) as {
          data: { email: string }[];
        };
        return okJson({
          data: body.data.map((l) => ({ id: nextId++, email: l.email })),
        });
      }
      return okJson({ data: { success: true, message: "Leads attached" } });
    });
  }

  it("batches creates in 100s and attaches all ids in one call", async () => {
    const leads = Array.from({ length: 250 }, (_, i) => ({
      email: `lead${i}@example.com`,
      firstName: `F${i}`,
    }));
    const fetchImpl = leadsFetch();
    const out = await pushLeads(CONN, 7, leads, fetchImpl);
    expect(out).toEqual({ attached: 250, skipped: 0, message: "Leads attached" });
    // 3 sequential creates (100/100/50) + exactly one attach.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const createSizes = calls
      .filter(([u]) => u.includes("create-or-update"))
      .map(([, i]) => (JSON.parse(i.body as string) as { data: unknown[] }).data.length);
    expect(createSizes).toEqual([100, 100, 50]);
    expect(calls[3][0]).toBe(
      "https://dedi.emailbison.com/api/campaigns/7/leads/attach-leads",
    );
    const attachBody = JSON.parse(calls[3][1].body as string) as {
      lead_ids: number[];
    };
    expect(attachBody.lead_ids).toHaveLength(250);
    expect(attachBody.lead_ids[0]).toBe(1000);
    expect(attachBody.lead_ids[249]).toBe(1249);
  });

  it("skips malformed emails, reports the count, and snake_cases names", async () => {
    const fetchImpl = leadsFetch();
    const out = await pushLeads(
      CONN,
      7,
      [
        { email: "good@example.com", lastName: "Reyes" },
        { email: "no-at-sign" },
        { email: "spaces in@bad.com" },
        { email: "@nodomain" },
      ],
      fetchImpl,
    );
    expect(out.attached).toBe(1);
    expect(out.skipped).toBe(3);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      data: [{ email: "good@example.com", last_name: "Reyes" }],
    });
  });

  it("rejects an empty batch and short-circuits when nothing is valid", async () => {
    const fetchImpl = vi.fn(async () => okJson({}));
    await expect(pushLeads(CONN, 7, [], fetchImpl)).rejects.toThrow(
      /at least one lead/,
    );
    expect(await pushLeads(CONN, 7, [{ email: "nope" }], fetchImpl)).toEqual({
      attached: 0,
      skipped: 1,
      message: "no valid email addresses",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
