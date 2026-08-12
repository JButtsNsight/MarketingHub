// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

const h = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  listCronRuns: vi.fn(),
  scheduleCronJob: vi.fn(),
  unscheduleCronJob: vi.fn(),
}));

vi.mock("@/lib/console/cron", () => ({
  listCronJobs: h.listCronJobs,
  listCronRuns: h.listCronRuns,
  scheduleCronJob: h.scheduleCronJob,
  unscheduleCronJob: h.unscheduleCronJob,
}));

import { DELETE, GET, POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["mh-section-platform"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.listCronJobs.mockResolvedValue([]);
  h.listCronRuns.mockResolvedValue([]);
});

afterEach(() => {
  clearAlbEnv();
});

function req(
  method: string,
  body?: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  },
  url = "http://x/api/console/cron",
) {
  return new Request(url, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

describe("GET /api/console/cron", () => {
  test("401 unauthenticated / 403 wrong group before any read", async () => {
    expect(
      (await GET(req("GET", undefined, {}))).status,
    ).toBe(401);
    expect(
      (
        await GET(req("GET", undefined, { "x-amzn-oidc-data": viewersToken }))
      ).status,
    ).toBe(403);
    expect(h.listCronJobs).not.toHaveBeenCalled();
    expect(h.listCronRuns).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await GET(
      req("GET", undefined, { "x-amzn-oidc-data": marketingToken }),
    );
    expect(forbidden.status).toBe(403);
    expect(h.listCronJobs).not.toHaveBeenCalled();

    const admin = await GET(
      req("GET", undefined, { "x-amzn-oidc-data": adminToken }),
    );
    expect(admin.status).toBe(200);
  });

  test("returns jobs + runs for the group", async () => {
    h.listCronJobs.mockResolvedValue([{ jobid: 3, jobname: "nightly" }]);
    h.listCronRuns.mockResolvedValue([{ runid: 9, jobid: 3, status: "succeeded" }]);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [{ jobid: 3, jobname: "nightly" }],
      runs: [{ runid: 9, jobid: 3, status: "succeeded" }],
    });
    // Unscoped read → no jobid passed to the data layer.
    expect(h.listCronRuns).toHaveBeenCalledWith({ jobid: undefined, limit: undefined });
  });

  test("scopes runs to a validated jobid", async () => {
    await GET(req("GET", undefined, undefined, "http://x/api/console/cron?jobid=7"));
    expect(h.listCronRuns).toHaveBeenCalledWith({ jobid: 7, limit: undefined });
  });

  test("400 on a non-integer jobid without touching the data layer", async () => {
    const res = await GET(
      req("GET", undefined, undefined, "http://x/api/console/cron?jobid=1.5"),
    );
    expect(res.status).toBe(400);
    expect(h.listCronRuns).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/cron", () => {
  test("403 for the wrong group before scheduling", async () => {
    const res = await POST(
      req(
        "POST",
        { name: "j", schedule: "* * * * *", command: "select 1" },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.scheduleCronJob).not.toHaveBeenCalled();
  });

  test("schedules a job and returns the new jobid (201)", async () => {
    h.scheduleCronJob.mockResolvedValue(42);
    const res = await POST(
      req("POST", {
        name: "  refresh-mv  ",
        schedule: "*/5 * * * *",
        command: "refresh materialized view marketinghub.mv",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ jobid: 42 });
    // zod trims the name before it reaches the data layer.
    expect(h.scheduleCronJob).toHaveBeenCalledWith({
      name: "refresh-mv",
      schedule: "*/5 * * * *",
      command: "refresh materialized view marketinghub.mv",
    });
  });

  test("400 on a missing/empty field without touching the data layer", async () => {
    const res = await POST(
      req("POST", { name: "", schedule: "* * * * *", command: "select 1" }),
    );
    expect(res.status).toBe(400);
    expect(h.scheduleCronJob).not.toHaveBeenCalled();
  });

  test("maps a [console:cron] failure to 400 with the real message", async () => {
    h.scheduleCronJob.mockRejectedValue(
      new Error('[console:cron] schedule failed: invalid cron expression'),
    );
    const res = await POST(
      req("POST", { name: "j", schedule: "nope", command: "select 1" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid cron expression");
  });

  test("400 on malformed JSON", async () => {
    expect((await POST(req("POST", "{nope"))).status).toBe(400);
    expect(h.scheduleCronJob).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/console/cron", () => {
  test("403 for the wrong group before unscheduling", async () => {
    const res = await DELETE(
      req(
        "DELETE",
        { jobid: 3 },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.unscheduleCronJob).not.toHaveBeenCalled();
  });

  test("unschedules by jobid", async () => {
    h.unscheduleCronJob.mockResolvedValue(true);
    const res = await DELETE(req("DELETE", { jobid: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unscheduled: true });
    expect(h.unscheduleCronJob).toHaveBeenCalledWith(3);
  });

  test("404 when pg_cron reports no such job", async () => {
    h.unscheduleCronJob.mockResolvedValue(false);
    const res = await DELETE(req("DELETE", { jobid: 999 }));
    expect(res.status).toBe(404);
  });

  test("400 on a non-integer jobid without touching the data layer", async () => {
    const res = await DELETE(req("DELETE", { jobid: 1.5 }));
    expect(res.status).toBe(400);
    expect(h.unscheduleCronJob).not.toHaveBeenCalled();
  });
});
