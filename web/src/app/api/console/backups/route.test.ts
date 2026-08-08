// @vitest-environment node
// The route runs the verified (jose ES256) ALB auth path; node env avoids the
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

// Mock the server-only backups lib; the route is the unit under test.
const h = vi.hoisted(() => ({
  getBackupSnapshot: vi.fn(),
  getLastArchivedAt: vi.fn(),
}));

vi.mock("@/lib/console/backups", () => ({
  getBackupSnapshot: h.getBackupSnapshot,
  getLastArchivedAt: h.getLastArchivedAt,
  STALE_AFTER_MINUTES: 45,
}));

import { GET } from "./route";

let marketingToken: string;
let viewersToken: string;

const SNAPSHOT = {
  capturedAt: "2026-08-08 14:00:05+00",
  stanza: {
    name: "supabase",
    statusCode: 0,
    statusMessage: "ok",
    backupLockHeld: false,
    backups: [
      {
        label: "20260802-020001F",
        type: "full",
        startedAt: "2026-08-02T02:00:01.000Z",
        stoppedAt: "2026-08-02T02:12:31.000Z",
        dbSizeBytes: 1073741824,
        repoSizeBytes: 268435456,
        error: false,
        prior: null,
        reference: null,
      },
    ],
    archiveMin: "000000010000000000000001",
    archiveMax: "0000000100000000000000AB",
  },
  raw: [],
};

const LAST_ARCHIVED = "2026-08-08 13:58:12.412+00";

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.getBackupSnapshot.mockReset().mockResolvedValue(SNAPSHOT);
  h.getLastArchivedAt.mockReset().mockResolvedValue(LAST_ARCHIVED);
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

describe("GET /api/console/backups", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request("http://x/api/console/backups"));
    expect(res.status).toBe(401);
    expect(h.getBackupSnapshot).not.toHaveBeenCalled();
    expect(h.getLastArchivedAt).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const res = await GET(
      new Request("http://x/api/console/backups", {
        headers: { "x-amzn-oidc-data": viewersToken },
      }),
    );
    expect(res.status).toBe(403);
    expect(h.getBackupSnapshot).not.toHaveBeenCalled();
    expect(h.getLastArchivedAt).not.toHaveBeenCalled();
  });

  test("200 returns the snapshot plus the archiver cross-check", async () => {
    const res = await GET(
      new Request("http://x/api/console/backups", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      snapshot: SNAPSHOT,
      lastArchivedAt: LAST_ARCHIVED,
    });
  });

  test("a null snapshot (reporter not installed) is an honest 200, not an error — and skips the archiver read", async () => {
    h.getBackupSnapshot.mockResolvedValue(null);
    const res = await GET(
      new Request("http://x/api/console/backups", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snapshot: null, lastArchivedAt: null });
    expect(h.getLastArchivedAt).not.toHaveBeenCalled();
  });

  test("a failing archiver cross-check degrades to lastArchivedAt: null without hiding the snapshot", async () => {
    h.getLastArchivedAt.mockRejectedValue(
      new Error("[console:pgmeta] query failed: connection refused"),
    );
    const res = await GET(
      new Request("http://x/api/console/backups", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snapshot: SNAPSHOT, lastArchivedAt: null });
  });

  test("maps a [console:*] snapshot failure to 400 with the stripped message", async () => {
    h.getBackupSnapshot.mockRejectedValue(
      new Error("[console:pgmeta] query failed: pg-meta exploded"),
    );
    const res = await GET(
      new Request("http://x/api/console/backups", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pg-meta exploded");
  });
});
