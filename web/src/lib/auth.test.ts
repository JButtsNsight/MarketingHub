import { describe, it, expect } from "vitest";
import { getUser, requireUser, AuthError, type AppUser } from "./auth";

/** Encode a claims object as the ALB `x-amzn-oidc-data` JWT payload segment. */
function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build a fake three-part ALB OIDC-data JWT (header.payload.signature). */
function oidcData(claims: Record<string, unknown>): string {
  const header = base64url({ typ: "JWT", alg: "ES256", kid: "abc" });
  const payload = base64url(claims);
  return `${header}.${payload}.signature-not-verified`;
}

function headersWith(token?: string): Headers {
  const h = new Headers();
  if (token) h.set("x-amzn-oidc-data", token);
  return h;
}

describe("getUser", () => {
  it("decodes email, name, and groups from the ALB OIDC-data JWT", () => {
    const token = oidcData({
      email: "casey@nsightcare.com",
      name: "Casey Marketer",
      "cognito:groups": ["marketing", "marketinghub-admins"],
    });
    const user = getUser(headersWith(token));
    expect(user).toEqual<AppUser>({
      email: "casey@nsightcare.com",
      name: "Casey Marketer",
      groups: ["marketing", "marketinghub-admins"],
    });
  });

  it("accepts cognito:groups rendered as a bracketed/space string", () => {
    // ALB sometimes serializes the groups claim as a string, e.g. "[marketing admins]".
    const token = oidcData({
      email: "dana@nsightcare.com",
      "cognito:groups": "[marketing admins]",
    });
    const user = getUser(headersWith(token));
    expect(user?.groups).toEqual(["marketing", "admins"]);
  });

  it("falls back to email for the display name when no name claim is present", () => {
    const token = oidcData({ email: "nomane@nsightcare.com", "cognito:groups": [] });
    expect(getUser(headersWith(token))?.name).toBe("nomane@nsightcare.com");
  });

  it("returns null when the header is absent", () => {
    expect(getUser(headersWith())).toBeNull();
  });

  it("returns null on a malformed token (no payload segment)", () => {
    expect(getUser(headersWith("garbage"))).toBeNull();
  });

  it("returns null when the payload carries no email", () => {
    const token = oidcData({ "cognito:groups": ["marketing"] });
    expect(getUser(headersWith(token))).toBeNull();
  });

  it("reads from a plain header record as well as a Headers instance", () => {
    const token = oidcData({ email: "rec@nsightcare.com", "cognito:groups": ["marketing"] });
    const user = getUser({ "x-amzn-oidc-data": token });
    expect(user?.email).toBe("rec@nsightcare.com");
  });
});

describe("requireUser", () => {
  const token = oidcData({
    email: "casey@nsightcare.com",
    name: "Casey",
    "cognito:groups": ["marketing"],
  });

  it("returns the user when the required group is present", () => {
    const user = requireUser(headersWith(token), "marketing");
    expect(user.email).toBe("casey@nsightcare.com");
  });

  it("returns the user when no specific group is required", () => {
    expect(requireUser(headersWith(token)).email).toBe("casey@nsightcare.com");
  });

  it("throws a 401 AuthError when there is no authenticated user", () => {
    try {
      requireUser(headersWith(), "marketing");
      throw new Error("expected requireUser to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });

  it("throws a 403 AuthError when the user lacks the required group", () => {
    try {
      requireUser(headersWith(token), "marketinghub-admins");
      throw new Error("expected requireUser to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(403);
    }
  });
});
