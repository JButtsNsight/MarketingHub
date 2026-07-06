import { describe, it, expect } from "vitest";
import { buildLogoutResponse } from "./route";

const LOGOUT_URL =
  "https://nsight-marketinghub.auth.us-east-1.amazoncognito.com/logout?client_id=abc&logout_uri=https%3A%2F%2Fmarketinghub.nsightcare.com%2F";

describe("/logout route", () => {
  it("302-redirects to the Cognito Hosted-UI logout URL", () => {
    const res = buildLogoutResponse(LOGOUT_URL);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LOGOUT_URL);
  });

  it("expires both ALB auth-session cookie shards", () => {
    const res = buildLogoutResponse(LOGOUT_URL);
    const cookies = res.headers.getSetCookie();
    const shard0 = cookies.find((c) => c.startsWith("AWSELBAuthSessionCookie-0="));
    const shard1 = cookies.find((c) => c.startsWith("AWSELBAuthSessionCookie-1="));
    expect(shard0).toBeDefined();
    expect(shard1).toBeDefined();
    for (const c of [shard0!, shard1!]) {
      expect(c).toMatch(/Max-Age=0/);
      expect(c).toMatch(/Path=\//);
    }
  });

  it("fails loud when COGNITO_LOGOUT_URL is not configured", () => {
    expect(() => buildLogoutResponse(undefined)).toThrow(/COGNITO_LOGOUT_URL/);
  });
});
