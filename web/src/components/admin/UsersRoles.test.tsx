import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RoleUser } from "@/app/api/console/cognito/users/route";
import { UsersRoles } from "./UsersRoles";

/**
 * The client talks to the world ONLY through fetch("/api/console/cognito/…"),
 * so a stubbed global fetch drives every state: the populated table with
 * toggle chips, the optimistic apply + revert-on-failure, the own-god-mode
 * lockout UX, and the honest 503 "Cognito unreachable" answer.
 */

const AMY: RoleUser = {
  username: "u-amy",
  email: "amy@nsight.example",
  status: "CONFIRMED",
  created: "2026-08-01T00:00:00.000Z",
  enabled: true,
  groups: ["marketing", "marketinghub-admins"],
};

const BOB: RoleUser = {
  username: "u-bob",
  email: "bob@nsight.example",
  status: "FORCE_CHANGE_PASSWORD",
  created: "2026-08-02T00:00:00.000Z",
  enabled: true,
  groups: ["marketing", "legacy-extra-group"],
};

const DISABLED_USER: RoleUser = {
  username: "u-dan",
  email: "dan@nsight.example",
  status: "CONFIRMED",
  created: null,
  enabled: false,
  groups: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface StubAnswers {
  list?: { body: unknown; status?: number };
  grant?: { body: unknown; status?: number };
}

/** Route-aware fetch stub — GET list and POST grants answer differently. */
function stubFetch(answers: StubAnswers = {}) {
  const list = answers.list ?? { body: { users: [AMY, BOB, DISABLED_USER] } };
  const grant = answers.grant ?? { body: { ok: true } };
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/console/cognito/users") {
      return Promise.resolve(jsonResponse(list.body, list.status ?? 200));
    }
    if (url.pathname === "/api/console/cognito/grants" && init?.method === "POST") {
      return Promise.resolve(jsonResponse(grant.body, grant.status ?? 200));
    }
    return Promise.resolve(jsonResponse({ error: "no stub for url" }, 500));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The grants POST bodies fetch saw, parsed. */
function sentGrants(fn: ReturnType<typeof stubFetch>): unknown[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes("/grants"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

async function renderLoaded(currentEmail = "amy@nsight.example") {
  render(<UsersRoles currentEmail={currentEmail} />);
  await waitFor(() =>
    expect(screen.getByText("amy@nsight.example")).toBeInTheDocument(),
  );
}

function rowOf(email: string): HTMLElement {
  return screen.getByText(email).closest("tr") as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UsersRoles — table", () => {
  test("renders users with status, created, and pressed chips per membership", async () => {
    stubFetch();
    await renderLoaded();

    const amy = rowOf("amy@nsight.example");
    expect(within(amy).getByText("confirmed")).toBeInTheDocument();
    expect(within(amy).getByText("2026-08-01T00:00:00.000Z")).toBeInTheDocument();
    expect(
      within(amy).getByRole("button", { name: "marketing" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(amy).getByRole("button", { name: "platform" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(within(amy).getByRole("button", { name: "intel" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(amy).getByRole("button", { name: "god-mode" }),
    ).toHaveAttribute("aria-pressed", "true");

    // Disabled pool user reads as a failure state.
    const dan = rowOf("dan@nsight.example");
    expect(within(dan).getByText("disabled")).toBeInTheDocument();
    expect(screen.getByText("3 users")).toBeInTheDocument();
  });

  test("groups outside the registry render as plain badges, not toggles", async () => {
    stubFetch();
    await renderLoaded();
    const bob = rowOf("bob@nsight.example");
    expect(within(bob).getByText("legacy-extra-group")).toBeInTheDocument();
    expect(
      within(bob).queryByRole("button", { name: "legacy-extra-group" }),
    ).not.toBeInTheDocument();
  });

  test("load failure renders the terse error", async () => {
    stubFetch({ list: { body: { error: "admin-only" }, status: 403 } });
    render(<UsersRoles currentEmail="amy@nsight.example" />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("admin-only"),
    );
  });

  test("503 unavailable renders the honest 'Cognito unreachable' state", async () => {
    stubFetch({
      list: { body: { error: "pool down", unavailable: true }, status: 503 },
    });
    render(<UsersRoles currentEmail="amy@nsight.example" />);
    await waitFor(() =>
      expect(screen.getByText("Cognito unreachable")).toBeInTheDocument(),
    );
  });
});

describe("UsersRoles — toggles", () => {
  test("granting posts {username, group, action:'add'} and flips optimistically", async () => {
    const fn = stubFetch();
    await renderLoaded();

    const platform = within(rowOf("bob@nsight.example")).getByRole("button", {
      name: "platform",
    });
    await userEvent.click(platform);

    expect(sentGrants(fn)).toEqual([
      { username: "u-bob", group: "mh-section-platform", action: "add" },
    ]);
    await waitFor(() =>
      expect(platform).toHaveAttribute("aria-pressed", "true"),
    );
  });

  test("revoking posts action:'remove'", async () => {
    const fn = stubFetch();
    await renderLoaded();

    await userEvent.click(
      within(rowOf("bob@nsight.example")).getByRole("button", {
        name: "marketing",
      }),
    );
    expect(sentGrants(fn)).toEqual([
      { username: "u-bob", group: "marketing", action: "remove" },
    ]);
  });

  test("a failed change reverts the chip and shows the server's error", async () => {
    stubFetch({
      grant: { body: { error: "Cognito pool did not answer." }, status: 503 },
    });
    await renderLoaded();

    const intel = within(rowOf("bob@nsight.example")).getByRole("button", {
      name: "intel",
    });
    await userEvent.click(intel);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Cognito pool did not answer.",
      ),
    );
    expect(intel).toHaveAttribute("aria-pressed", "false"); // reverted
  });

  test("your OWN god-mode chip is disabled (lockout UX); others' stay live", async () => {
    stubFetch();
    await renderLoaded("amy@nsight.example");

    const own = within(rowOf("amy@nsight.example")).getByRole("button", {
      name: "god-mode",
    });
    expect(own).toBeDisabled();
    expect(own).toHaveAttribute("title", "You can't remove your own god-mode.");

    expect(
      within(rowOf("bob@nsight.example")).getByRole("button", {
        name: "god-mode",
      }),
    ).toBeEnabled();
  });
});
