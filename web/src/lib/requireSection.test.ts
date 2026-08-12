// @vitest-environment node
// Exercises the verified (jose ES256) auth path via requireUser; node env avoids
// the jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuthError } from "./auth";
import {
  ADMIN_GROUP,
  ALL_ASSIGNABLE_GROUPS,
  MARKETING_GROUP,
  SECTIONS,
  sectionAllows,
} from "./authGroups";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "./__test__/albToken";

const h = vi.hoisted(() => ({
  headerValue: null as string | null,
  redirect: vi.fn((_url: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "x-amzn-oidc-data" ? h.headerValue : null,
    }),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import { requireSectionApi, requireSectionUser } from "./requireSection";

function headersWith(token?: string): Headers {
  const headers = new Headers();
  if (token) headers.set("x-amzn-oidc-data", token);
  return headers;
}

function tokenFor(groups: string[]): Promise<string> {
  return signAlbToken({
    email: "casey@nsightcare.com",
    "cognito:groups": groups,
  });
}

beforeAll(async () => {
  await initAlbKeys();
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.headerValue = null;
  h.redirect.mockClear();
});

afterEach(() => {
  clearAlbEnv();
});

describe("SECTIONS registry", () => {
  it("registers platform + intel with their fixed Cognito groups", () => {
    expect(SECTIONS.map((s) => ({ id: s.id, group: s.group }))).toEqual([
      { id: "platform", group: "mh-section-platform" },
      { id: "intel", group: "mh-section-intel" },
    ]);
  });

  it("platform unlocks the Platform + Integrations nav groups", () => {
    const platform = SECTIONS.find((s) => s.id === "platform")!;
    expect(platform.navGroups).toEqual(["Platform", "Integrations"]);
  });

  it("ALL_ASSIGNABLE_GROUPS is exactly marketing, both sections, admin", () => {
    expect(ALL_ASSIGNABLE_GROUPS).toEqual([
      MARKETING_GROUP,
      "mh-section-platform",
      "mh-section-intel",
      ADMIN_GROUP,
    ]);
  });

  it("sectionAllows: section group OR god-mode admin; nothing else", () => {
    expect(sectionAllows({ groups: ["mh-section-platform"] }, "platform")).toBe(true);
    expect(sectionAllows({ groups: [ADMIN_GROUP] }, "platform")).toBe(true);
    expect(sectionAllows({ groups: [ADMIN_GROUP] }, "intel")).toBe(true);
    expect(sectionAllows({ groups: [MARKETING_GROUP] }, "platform")).toBe(false);
    expect(sectionAllows({ groups: ["mh-section-intel"] }, "platform")).toBe(false);
    expect(sectionAllows({ groups: [] }, "intel")).toBe(false);
  });
});

describe("requireSectionUser (page gate)", () => {
  it("returns ok + the user for a section-group member", async () => {
    h.headerValue = await tokenFor([MARKETING_GROUP, "mh-section-platform"]);
    const gate = await requireSectionUser("platform");
    expect(gate).toMatchObject({
      ok: true,
      user: { email: "casey@nsightcare.com" },
    });
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("returns ok for an admin WITHOUT the section group (god-mode)", async () => {
    h.headerValue = await tokenFor([ADMIN_GROUP]);
    expect(await requireSectionUser("intel")).toMatchObject({ ok: true });
  });

  it("returns ok:false (NOT a /login redirect) for a signed-in user without the section", async () => {
    h.headerValue = await tokenFor([MARKETING_GROUP]);
    expect(await requireSectionUser("platform")).toEqual({ ok: false });
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("does not leak one section's group into another", async () => {
    h.headerValue = await tokenFor([MARKETING_GROUP, "mh-section-intel"]);
    expect(await requireSectionUser("platform")).toEqual({ ok: false });
  });

  it("redirects a signed-OUT user to /login", async () => {
    h.headerValue = null;
    await expect(requireSectionUser("platform")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });
});

describe("requireSectionApi (route gate)", () => {
  it("returns the user for a section-group member", async () => {
    const headers = headersWith(await tokenFor(["mh-section-intel"]));
    const user = await requireSectionApi(headers, "intel");
    expect(user.email).toBe("casey@nsightcare.com");
  });

  it("passes an admin without the section group", async () => {
    const headers = headersWith(await tokenFor([ADMIN_GROUP]));
    await expect(requireSectionApi(headers, "platform")).resolves.toMatchObject({
      email: "casey@nsightcare.com",
    });
  });

  it("throws 403 (naming the section group) for a user without the section", async () => {
    const headers = headersWith(await tokenFor([MARKETING_GROUP]));
    await expect(requireSectionApi(headers, "platform")).rejects.toMatchObject({
      status: 403,
      message: "Requires Cognito group: mh-section-platform",
    });
    await expect(requireSectionApi(headers, "platform")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("throws 401 when unauthenticated", async () => {
    await expect(requireSectionApi(headersWith(), "intel")).rejects.toMatchObject({
      status: 401,
    });
  });
});
