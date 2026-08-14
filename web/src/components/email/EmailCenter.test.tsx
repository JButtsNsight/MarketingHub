import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmailCenter } from "./EmailCenter";
import type { BisonCampaign } from "@/lib/email/bison.shared";
import type { ContactList } from "@/lib/contacts/schema";

function mkCampaign(over: Partial<BisonCampaign>): BisonCampaign {
  return {
    id: 1,
    uuid: "u-1",
    name: "Camp",
    status: "Active",
    emailsSent: 10,
    uniqueOpens: 5,
    uniqueReplies: 2,
    bounced: 1,
    unsubscribed: 0,
    interested: 1,
    totalLeads: 100,
    updatedAt: "2026-08-10T00:00:00Z",
    ...over,
  };
}

const ACTIVE = mkCampaign({ id: 123, uuid: "u-123", name: "Alpha" });
const PAUSED = mkCampaign({
  id: 456,
  uuid: "u-456",
  name: "Beta",
  status: "Paused",
});

function mkList(
  over: Partial<ContactList> & Pick<ContactList, "id" | "name" | "source">,
): ContactList {
  return {
    storage_path: null,
    original_filename: null,
    monday_board_id: null,
    monday_board_name: null,
    monday_phone_column_id: null,
    monday_timezone_column_id: null,
    monday_outcome_column_id: null,
    contact_count: 0,
    invalid_count: 0,
    duplicate_count: 0,
    created_by: "t@nsight.com",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const CSV_LIST_ID = "0f0e0d0c-0b0a-4a4b-8c8d-1a2b3c4d5e6f";
const LISTS = [
  mkList({ id: CSV_LIST_ID, name: "August CSV", source: "csv", contact_count: 42 }),
  mkList({ id: "9f9e9d9c-0b0a-4a4b-8c8d-1a2b3c4d5e6f", name: "Board list", source: "monday" }),
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response> | null;

/** Route table for the center's fetches; `handler` overrides per test. */
function installFetch(handler?: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (handler) {
      const hit = handler(url, init);
      if (hit) return hit;
    }
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/email/connection")) {
      return json({
        provisioned: true,
        connected: true,
        baseUrl: "https://dedi.emailbison.com",
        workspaceName: "NSight",
      });
    }
    if (url.startsWith("/api/email/campaigns?")) {
      return json({
        connected: true,
        campaigns: [ACTIVE, PAUSED],
        meta: { currentPage: 1, lastPage: 1, total: 2 },
      });
    }
    if (method === "POST" && /\/api\/email\/campaigns\/\d+\/action$/.test(url)) {
      return json({ ok: true });
    }
    if (method === "POST" && /\/api\/email\/campaigns\/\d+\/push-list$/.test(url)) {
      return json({ attached: 12, skipped: 3, message: "ok" });
    }
    if (url === "/api/email/campaigns/create") {
      return json({ id: 999, name: "Q4 outreach", status: "Draft" });
    }
    if (url.startsWith("/api/contact-lists")) {
      return json({ lists: LISTS });
    }
    return json({ error: "unexpected route" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderConnected() {
  render(<EmailCenter admin={false} />);
  await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
}

describe("EmailCenter dashboard", () => {
  test("keeps EmailBison's stat vocabulary and order, statuses verbatim", async () => {
    installFetch();
    await renderConnected();

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Campaign",
      "Status",
      "Leads",
      "Sent",
      "Opens",
      "Replies",
      "Interested",
      "Bounced",
      "Unsubs",
      "Updated",
      "Actions",
    ]);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  test("Pause POSTs the action and refetches the table", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/email/campaigns/123/action");
      expect(post).toBeDefined();
      expect(post!.init?.body).toBe(JSON.stringify({ action: "pause" }));
    });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.startsWith("/api/email/campaigns?")).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  test("Pause disables with a busy label while in flight", async () => {
    let release!: () => void;
    const gate = new Promise<Response>((res) => {
      release = () => res(json({ ok: true }));
    });
    installFetch((url, init) =>
      init?.method === "POST" && url.endsWith("/action") ? gate : null,
    );
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    const busyBtn = await screen.findByRole("button", { name: "Pausing…" });
    expect(busyBtn).toBeDisabled();
    // Every other mutating row control is disabled while one is in flight.
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled(),
    );
  });

  test("Resume asks for confirmation; cancelling does nothing", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("Resume sending?")).toBeInTheDocument();

    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.url.endsWith("/action"))).toBe(false);
  });

  test("Resume confirm POSTs resume for the paused campaign", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    const dlg = await screen.findByRole("alertdialog");
    await user.click(within(dlg).getByRole("button", { name: "Resume" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/email/campaigns/456/action");
      expect(post).toBeDefined();
      expect(post!.init?.body).toBe(JSON.stringify({ action: "resume" }));
    });
  });

  test("action failure shows the upstream message inline with Retry; rows survive", async () => {
    const { calls } = installFetch((url, init) =>
      init?.method === "POST" && url.endsWith("/action")
        ? json({ error: "upstream down" }, 502)
        : null,
    );
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByText(/upstream down/);
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/action")).length).toBe(2),
    );
  });

  test("campaign load failure shows Retry without wiping the view; Retry recovers", async () => {
    let failed = false;
    installFetch((url) => {
      if (url.startsWith("/api/email/campaigns?") && !failed) {
        failed = true;
        return json({ error: "bison 500" }, 502);
      }
      return null;
    });
    const user = userEvent.setup();
    render(<EmailCenter admin={false} />);

    await screen.findByText(/bison 500/);
    // The table stays rendered alongside the inline error.
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
  });

  test("Push contacts: picks a CSV list, POSTs it, reports counts + the ~5-minute note", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(
      screen.getAllByRole("button", { name: "Push contacts" })[0],
    );
    const dlg = await screen.findByRole("dialog");
    expect(
      within(dlg).getByText("Push contacts to “Alpha”"),
    ).toBeInTheDocument();

    // Monday-backed lists are filtered out with an honest hint.
    await within(dlg).findByRole("option", { name: "August CSV — 42 contacts" });
    expect(
      within(dlg).queryByRole("option", { name: /Board list/ }),
    ).not.toBeInTheDocument();
    expect(
      within(dlg).getByText("Monday-backed lists aren't pushable yet."),
    ).toBeInTheDocument();

    expect(within(dlg).getByRole("button", { name: "Push" })).toBeDisabled();
    await user.selectOptions(
      within(dlg).getByLabelText("Contact list"),
      CSV_LIST_ID,
    );
    await user.click(within(dlg).getByRole("button", { name: "Push" }));

    await waitFor(() => {
      const post = calls.find((c) =>
        c.url.endsWith("/api/email/campaigns/123/push-list"),
      );
      expect(post).toBeDefined();
      expect(post!.init?.body).toBe(
        JSON.stringify({ contactListId: CSV_LIST_ID }),
      );
    });
    await screen.findByText(
      "12 attached · 3 skipped — leads can take ~5 minutes to appear on active campaigns",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The dashboard refetched after the mutation.
    expect(
      calls.filter((c) => c.url.startsWith("/api/email/campaigns?")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("push failure keeps the dialog open with the upstream message", async () => {
    installFetch((url, init) =>
      init?.method === "POST" && url.endsWith("/push-list")
        ? json({ error: "no members with an email address" }, 422)
        : null,
    );
    const user = userEvent.setup();
    await renderConnected();

    await user.click(
      screen.getAllByRole("button", { name: "Push contacts" })[0],
    );
    const dlg = await screen.findByRole("dialog");
    await user.selectOptions(
      within(dlg).getByLabelText("Contact list"),
      CSV_LIST_ID,
    );
    await user.click(within(dlg).getByRole("button", { name: "Push" }));

    await within(dlg).findByText("no members with an email address");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("New campaign creates a draft, links out, and refetches", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "New campaign" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("button", { name: "Create" })).toBeDisabled();

    await user.type(
      within(dlg).getByLabelText("Campaign name"),
      "Q4 outreach",
    );
    await user.click(within(dlg).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/email/campaigns/create");
      expect(post).toBeDefined();
      expect(post!.init?.body).toBe(JSON.stringify({ name: "Q4 outreach" }));
    });
    await screen.findByText(/Draft created — finish the sequence in/);
    expect(screen.getByRole("link", { name: "EmailBison ↗" })).toHaveAttribute(
      "href",
      "https://dedi.emailbison.com",
    );
    expect(
      calls.filter((c) => c.url.startsWith("/api/email/campaigns?")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("Escape closes the push dialog without acting", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderConnected();

    await user.click(
      screen.getAllByRole("button", { name: "Push contacts" })[0],
    );
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls.some((c) => c.url.endsWith("/push-list"))).toBe(false);
  });

  test("header links out with the EmailBison name", async () => {
    installFetch();
    await renderConnected();
    expect(
      screen.getByRole("link", { name: "Open in EmailBison ↗" }),
    ).toHaveAttribute("href", "https://dedi.emailbison.com");
  });
});
