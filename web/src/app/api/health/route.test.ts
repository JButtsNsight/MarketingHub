// @vitest-environment node
import { describe, expect, test } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  test("returns 200 {status:'ok'} without any auth header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });

  test("does not read the ALB identity header (unauthenticated by design)", async () => {
    // The ALB routes /api/health with a plain forward (no authenticate-cognito),
    // so this handler must never depend on x-amzn-oidc-data. Calling it with no
    // argument at all must still succeed synchronously.
    expect(GET()).toHaveProperty("status", 200);
  });
});
