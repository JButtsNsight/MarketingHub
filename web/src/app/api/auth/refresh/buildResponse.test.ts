import { describe, expect, it } from "vitest";
import {
  AUTO_PROVISION_GUARD_COOKIE,
  buildRefreshResponse,
} from "./buildResponse";

describe("buildRefreshResponse", () => {
  it("expires BOTH ALB session shards and 302s into the app", () => {
    const res = buildRefreshResponse();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/overview");
    const cookies = res.headers.getSetCookie();
    for (const shard of ["AWSELBAuthSessionCookie-0", "AWSELBAuthSessionCookie-1"]) {
      const c = cookies.find((v) => v.startsWith(`${shard}=`));
      expect(c, shard).toBeDefined();
      expect(c).toContain("Max-Age=0");
      expect(c).toContain("HttpOnly");
      expect(c).toContain("Secure");
    }
  });

  it("arms the short-lived auto-provision loop guard", () => {
    const cookies = buildRefreshResponse().headers.getSetCookie();
    const guard = cookies.find((v) =>
      v.startsWith(`${AUTO_PROVISION_GUARD_COOKIE}=1`),
    );
    expect(guard).toBeDefined();
    expect(guard).toContain("Max-Age=120");
    expect(guard).toContain("HttpOnly");
  });
});
