import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { GoTrueUser } from "@/lib/console/gotrue";
import { AuthUsersClient } from "./AuthUsersClient";

/**
 * The client talks to the world ONLY through fetch("/api/console/gotrue/…"),
 * so a stubbed global fetch drives every state: the populated table, the
 * honest "No GoTrue users" empty state, the honest 503 "GoTrue unreachable"
 * answer, and the eager per-row detail expand.
 */

const CONFIRMED_USER: GoTrueUser = {
  id: "5f5e1f9d-6a3a-4d3e-9a51-1c2f3a4b5c6d",
  aud: "authenticated",
  role: "authenticated",
  email: "ada@nsight.example",
  app_metadata: { provider: "email" },
  user_metadata: { full_name: "Ada" },
  identities: null,
  created_at: "2026-08-01T00:00:00Z",
  last_sign_in_at: "2026-08-05T09:30:00Z",
  email_confirmed_at: "2026-08-01T00:05:00Z",
  is_anonymous: false,
};

const BANNED_USER: GoTrueUser = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  aud: "authenticated",
  role: "authenticated",
  email: "mallory@nsight.example",
  app_metadata: {},
  user_metadata: {},
  identities: null,
  created_at: "2026-07-01T00:00:00Z",
  last_sign_in_at: "2026-07-02T00:00:00Z",
  banned_until: "2999-01-01T00:00:00Z",
  email_confirmed_at: "2026-07-01T00:05:00Z",
  is_anonymous: false,
};

const ANON_USER: GoTrueUser = {
  id: "99999999-8888-7777-6666-555555555555",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  identities: null,
  created_at: "2026-08-02T00:00:00Z",
  is_anonymous: true,
};

const DETAIL_USER: GoTrueUser = {
  ...CONFIRMED_USER,
  identities: [
    {
      identity_id: "11111111-2222-3333-4444-555555555555",
      id: "ada@nsight.example",
      provider: "email",
      created_at: "2026-08-01T00:00:00Z",
      last_sign_in_at: "2026-08-05T09:30:00Z",
    },
  ],
  factors: [
    {
      id: "f1",
      factor_type: "totp",
      status: "verified",
      friendly_name: "Ada's phone",
      created_at: "2026-08-01T01:00:00Z",
    },
  ],
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Ada Lovelace" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface StubRoute {
  match: (url: URL) => boolean;
  body: unknown;
  status?: number;
}

/** Route-aware fetch stub — the list and detail endpoints answer differently. */
function stubFetch(routes: StubRoute[]) {
  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const route = routes.find((entry) => entry.match(url));
    if (!route) {
      return Promise.resolve(jsonResponse({ error: "no stub for url" }, 500));
    }
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const isList = (url: URL) => url.pathname === "/api/console/gotrue/users";
const isDetail = (url: URL) =>
  url.pathname.startsWith("/api/console/gotrue/users/");

/** Stub where every call answers with one list body. */
function stubList(body: unknown, status = 200) {
  return stubFetch([{ match: isList, body, status }]);
}

/** URL of the nth fetch call, parsed for easy searchParams assertions. */
function sentUrl(fn: ReturnType<typeof stubFetch>, call = 0): URL {
  return new URL(String(fn.mock.calls[call]?.[0]), "http://localhost");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthUsersClient — render states", () => {
  test("loads page 1 on mount and renders the populated table", async () => {
    const fn = stubList({
      users: [CONFIRMED_USER, BANNED_USER, ANON_USER],
      total: 3,
    });
    render(<AuthUsersClient />);

    const table = within(await screen.findByRole("table"));
    expect(table.getByText("ada@nsight.example")).toBeInTheDocument();
    expect(table.getByText("mallory@nsight.example")).toBeInTheDocument();
    // Anonymous rows have no email/phone — the identity cell says so.
    expect(table.getByText("anonymous")).toBeInTheDocument();
    // Missing last_sign_in_at renders as an honest "never".
    expect(table.getByText("never")).toBeInTheDocument();
    // Status badges: future banned_until wins; confirmed otherwise.
    expect(table.getByText("banned")).toBeInTheDocument();
    expect(table.getByText("confirmed")).toBeInTheDocument();
    expect(table.getByText("unconfirmed")).toBeInTheDocument();

    // The mount query is page 1, the fixed 50 per page, newest first.
    expect(fn).toHaveBeenCalledTimes(1);
    const url = sentUrl(fn);
    expect(url.pathname).toBe("/api/console/gotrue/users");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("desc");
    expect(url.searchParams.get("filter")).toBeNull();
  });

  test("zero users with no filter renders the honest 'No GoTrue users' state", async () => {
    stubList({ users: [], total: 0 });
    render(<AuthUsersClient />);

    expect(await screen.findByText("No GoTrue users")).toBeInTheDocument();
    // The copy explains WHY: Cognito is the front door until the SAML cutover.
    expect(screen.getByText(/Cognito/)).toBeInTheDocument();
    expect(screen.getByText(/Wave-3 SAML cutover/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("a 503 unavailable answer renders the honest 'GoTrue unreachable' state", async () => {
    stubList(
      { error: "gotrue unreachable: timed out after 30000 ms", unavailable: true },
      503,
    );
    render(<AuthUsersClient />);

    expect(await screen.findByText("GoTrue unreachable")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing else in the console is affected\./),
    ).toBeInTheDocument();
    // Never rendered as an empty user store.
    expect(screen.queryByText("No GoTrue users")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a 400 answer surfaces its error as an alert, not an empty state", async () => {
    stubList({ error: "sort must be one of asc, desc" }, 400);
    render(<AuthUsersClient />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sort must be one of asc, desc",
    );
    expect(screen.queryByText("No GoTrue users")).not.toBeInTheDocument();
    expect(screen.queryByText("GoTrue unreachable")).not.toBeInTheDocument();
  });

  test("outage → real error → recovery never co-renders stale states", async () => {
    const user = userEvent.setup();
    // Mutated between phases — stubFetch reads the array on every call.
    const listRoute: StubRoute = {
      match: isList,
      body: {
        error: "gotrue unreachable: 503 — GoTrue is unavailable behind Kong",
        unavailable: true,
      },
      status: 503,
    };
    stubFetch([listRoute]);
    render(<AuthUsersClient />);
    expect(await screen.findByText("GoTrue unreachable")).toBeInTheDocument();

    // GoTrue recovers but the service key is misconfigured: the next answer
    // is a REAL actionable failure. "Did not answer" and "answered with an
    // error" cannot both render — the stale outage panel must clear.
    listRoute.body = {
      error: "403 not_admin — SUPABASE_SERVICE_ROLE_KEY is not the service-role key",
    };
    listRoute.status = 400;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("403 not_admin");
    expect(screen.queryByText("GoTrue unreachable")).not.toBeInTheDocument();

    // Key fixed: the table renders and BOTH failure states are gone.
    listRoute.body = { users: [CONFIRMED_USER], total: 1 };
    listRoute.status = 200;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("ada@nsight.example")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("GoTrue unreachable")).not.toBeInTheDocument();
  });
});

describe("AuthUsersClient — row detail expand", () => {
  test("expanding a row fetches the eager detail and renders it; collapse hides it", async () => {
    const user = userEvent.setup();
    const fn = stubFetch([
      { match: isDetail, body: { user: DETAIL_USER } },
      { match: isList, body: { users: [CONFIRMED_USER], total: 1 } },
    ]);
    render(<AuthUsersClient />);

    const expand = await screen.findByRole("button", {
      name: "Expand user detail",
    });
    expect(screen.queryByText("email")).not.toBeInTheDocument();
    await user.click(expand);

    // The detail endpoint is hit with the row's id (list rows carry no
    // identities/factors by design).
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(sentUrl(fn, 1).pathname).toBe(
      `/api/console/gotrue/users/${CONFIRMED_USER.id}`,
    );

    // Identities table + factors + metadata JSON.
    expect(await screen.findByText("email")).toBeInTheDocument();
    expect(screen.getByText("Identities")).toBeInTheDocument();
    expect(screen.getByText("MFA factors (1)")).toBeInTheDocument();
    expect(screen.getByText("totp")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("Ada's phone")).toBeInTheDocument();
    expect(screen.getByText(/"full_name": "Ada Lovelace"/)).toBeInTheDocument();
    expect(screen.getByText(/"providers"/)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Collapse user detail" }),
    );
    expect(screen.queryByText("MFA factors (1)")).not.toBeInTheDocument();
    // Cached — collapsing and re-expanding does not refetch.
    await user.click(
      screen.getByRole("button", { name: "Expand user detail" }),
    );
    expect(await screen.findByText("MFA factors (1)")).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("a failing detail fetch shows an inline alert inside the row", async () => {
    const user = userEvent.setup();
    stubFetch([
      {
        match: isDetail,
        body: { error: "404 user_not_found: User not found" },
        status: 400,
      },
      { match: isList, body: { users: [CONFIRMED_USER], total: 1 } },
    ]);
    render(<AuthUsersClient />);

    await user.click(
      await screen.findByRole("button", { name: "Expand user detail" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "404 user_not_found: User not found",
    );
  });

  test("Refresh invalidates the detail cache so re-expand refetches", async () => {
    const user = userEvent.setup();
    const detailRoute: StubRoute = { match: isDetail, body: { user: DETAIL_USER } };
    const fn = stubFetch([
      detailRoute,
      { match: isList, body: { users: [CONFIRMED_USER], total: 1 } },
    ]);
    render(<AuthUsersClient />);

    await user.click(
      await screen.findByRole("button", { name: "Expand user detail" }),
    );
    expect(await screen.findByText("MFA factors (1)")).toBeInTheDocument();

    // Ada unenrolls her factor upstream, then the console user hits Refresh.
    // The refreshed detail answer omits `factors` entirely (upstream
    // omitempty drops empty lists) — the cached pre-refresh state must not
    // replay as if it were current.
    detailRoute.body = { user: { ...DETAIL_USER, factors: undefined } };
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(
      await screen.findByRole("button", { name: "Expand user detail" }),
    );

    expect(await screen.findByText("MFA factors (0)")).toBeInTheDocument();
    expect(screen.getByText("No MFA factors enrolled.")).toBeInTheDocument();
    // list, detail, refreshed list, refetched detail — no cache replay.
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(4));
  });

  test("re-expanding after a failed detail fetch retries instead of pinning the error", async () => {
    const user = userEvent.setup();
    const detailRoute: StubRoute = {
      match: isDetail,
      body: { error: "Network error — please try again." },
      status: 500,
    };
    const fn = stubFetch([
      detailRoute,
      { match: isList, body: { users: [CONFIRMED_USER], total: 1 } },
    ]);
    render(<AuthUsersClient />);

    await user.click(
      await screen.findByRole("button", { name: "Expand user detail" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network error — please try again.",
    );

    // The blip clears; collapse + re-expand must honor "please try again"
    // by refetching, not replaying the cached failure until a full reload.
    detailRoute.body = { user: DETAIL_USER };
    detailRoute.status = 200;
    await user.click(
      screen.getByRole("button", { name: "Collapse user detail" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Expand user detail" }),
    );
    expect(await screen.findByText("MFA factors (1)")).toBeInTheDocument();
    // list, failed detail, retried detail.
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("AuthUsersClient — query controls", () => {
  test("filter submit refetches page 1 with the trimmed filter param", async () => {
    const user = userEvent.setup();
    const fn = stubList({ users: [CONFIRMED_USER], total: 1 });
    render(<AuthUsersClient />);
    await screen.findByRole("table");

    await user.type(
      screen.getByRole("searchbox", { name: "Filter by email or full name" }),
      "  ada  ",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    const url = sentUrl(fn, 1);
    expect(url.searchParams.get("filter")).toBe("ada");
    expect(url.searchParams.get("page")).toBe("1");
  });

  test("the sort chip flips created_at direction and refetches from page 1", async () => {
    const user = userEvent.setup();
    const fn = stubList({ users: [CONFIRMED_USER], total: 1 });
    render(<AuthUsersClient />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "Newest first" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(sentUrl(fn, 1).searchParams.get("sort")).toBe("asc");
    expect(sentUrl(fn, 1).searchParams.get("page")).toBe("1");
    expect(
      await screen.findByRole("button", { name: "Oldest first" }),
    ).toBeInTheDocument();
  });

  test("pagination pages through X-Total-Count-derived pages", async () => {
    const user = userEvent.setup();
    const fn = stubList({ users: [CONFIRMED_USER], total: 120 });
    render(<AuthUsersClient />);

    expect(
      await screen.findByText("Page 1 of 3 — 120 users"),
    ).toBeInTheDocument();
    // No page 0 — Previous is disabled at the first page.
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(sentUrl(fn, 1).searchParams.get("page")).toBe("2");
    expect(
      await screen.findByText("Page 2 of 3 — 120 users"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  test("lands on the last real page when the total shrinks between queries", async () => {
    const user = userEvent.setup();
    // A stateful store: pages past the end answer honestly with users: [].
    let store = { users: [CONFIRMED_USER], total: 120 };
    const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageCount = Math.max(1, Math.ceil(store.total / 50));
      const body =
        page > pageCount ? { users: [], total: store.total } : store;
      return Promise.resolve(jsonResponse(body));
    });
    vi.stubGlobal("fetch", fn);
    render(<AuthUsersClient />);

    expect(
      await screen.findByText("Page 1 of 3 — 120 users"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 3 — 120 users");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 3 of 3 — 120 users");

    // 80 users are deleted via direct GoTrue admin tooling: page 3 no longer
    // exists. Refresh must not caption the impossible "Page 3 of 1".
    store = { users: [CONFIRMED_USER], total: 40 };
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("Page 1 of 1 — 40 users"),
    ).toBeInTheDocument();
    expect(screen.getByText("ada@nsight.example")).toBeInTheDocument();
    // The shrunken page-3 answer triggered exactly one follow-up query for
    // the last real page — mount, page 2, page 3, stale page 3, clamped 1.
    const pages = fn.mock.calls.map((call) =>
      new URL(String(call[0]), "http://localhost").searchParams.get("page"),
    );
    expect(pages).toEqual(["1", "2", "3", "3", "1"]);
  });
});

describe("AuthUsersClient — read-only surface", () => {
  test("renders zero mutation affordances (no invite/ban/delete/create)", async () => {
    stubList({ users: [CONFIRMED_USER, BANNED_USER], total: 2 });
    render(<AuthUsersClient />);
    await screen.findByRole("table");

    // The hard Wave 3-partial constraint: every button on this surface is a
    // query control or an expand toggle — nothing that writes.
    const buttonNames = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    for (const name of buttonNames) {
      expect(name).not.toMatch(/invite|ban|delete|create|remove|edit|save/i);
    }
  });
});
