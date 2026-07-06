// @vitest-environment node
// Exercises the verified (jose ES256) auth path via requireUser; node env avoids
// the jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
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

import { requireMarketingUser } from "./requireMarketingUser";

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

describe("requireMarketingUser (page gate)", () => {
  test("returns the user when they are in the marketing group", async () => {
    h.headerValue = await signAlbToken({
      email: "amy@nsight.example",
      "cognito:groups": ["marketing"],
    });
    const user = await requireMarketingUser();
    expect(user.email).toBe("amy@nsight.example");
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("redirects to /login when authenticated but NOT in the marketing group", async () => {
    h.headerValue = await signAlbToken({
      email: "bob@nsight.example",
      "cognito:groups": ["viewers"],
    });
    await expect(requireMarketingUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });

  test("redirects to /login when unauthenticated (no header)", async () => {
    h.headerValue = null;
    await expect(requireMarketingUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });
});
