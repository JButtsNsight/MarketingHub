import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RepliesList } from "./RepliesList";
import type { BisonReply } from "@/lib/email/bison.shared";

function mkReply(over: Partial<BisonReply>): BisonReply {
  return {
    id: 1,
    campaignId: 123,
    fromName: "Ada Lovelace",
    fromEmail: "ada@example.com",
    subject: "Re: Hello",
    body: "Sounds interesting, tell me more.",
    dateReceived: "2026-08-13T10:00:00Z",
    folder: "inbox",
    interested: false,
    read: true,
    ...over,
  };
}

const UNREAD_INTERESTED = mkReply({
  id: 1,
  interested: true,
  read: false,
  body: "y".repeat(130),
});
const READ_PLAIN = mkReply({
  id: 2,
  fromName: "Bob",
  fromEmail: "bob@example.com",
  subject: "Re: Pricing",
  body: "short",
});
const BOUNCED = mkReply({
  id: 3,
  fromName: "",
  fromEmail: "mailer-daemon@example.com",
  subject: "Undelivered",
  body: "bounced",
  folder: "bounced",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response> | null;

function installFetch(handler?: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (handler) {
      const hit = handler(url, init);
      if (hit) return hit;
    }
    if (url.startsWith("/api/email/connection")) {
      return json({
        provisioned: true,
        connected: true,
        baseUrl: "https://dedi.emailbison.com",
      });
    }
    if (url.startsWith("/api/email/replies")) {
      const u = new URL(url, "http://test");
      if (u.searchParams.get("folder") === "bounced") {
        return json({
          connected: true,
          replies: [BOUNCED],
          meta: { currentPage: 1, lastPage: 1, total: 1 },
        });
      }
      return json({
        connected: true,
        replies: [UNREAD_INTERESTED, READ_PLAIN],
        meta: {
          currentPage: Number(u.searchParams.get("page") ?? "1"),
          lastPage: 3,
          total: 60,
        },
      });
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

async function renderInbox() {
  render(<RepliesList />);
  await waitFor(() =>
    expect(
      screen.getByText("Ada Lovelace — ada@example.com"),
    ).toBeInTheDocument(),
  );
}

describe("RepliesList (Master Inbox)", () => {
  test("renders reply rows: from, subject, truncated preview, campaign, date, label chip", async () => {
    installFetch();
    await renderInbox();

    expect(screen.getByText("Re: Hello")).toBeInTheDocument();
    // Preview truncates to ~120 chars.
    expect(screen.getByText(`${"y".repeat(120)}…`)).toBeInTheDocument();
    expect(screen.getAllByText("123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-08-13").length).toBeGreaterThan(0);
    // "Interested" also exists as a filter option — assert the row chip.
    expect(
      within(screen.getByRole("table")).getByText("Interested"),
    ).toBeInTheDocument();
  });

  test("unread rows render bold; read rows do not", async () => {
    installFetch();
    await renderInbox();

    expect(
      screen.getByText("Ada Lovelace — ada@example.com"),
    ).toHaveStyle({ fontWeight: "600" });
    expect(
      screen.getByText("Bob — bob@example.com"),
    ).not.toHaveStyle({ fontWeight: "600" });
  });

  test("folders are tabs in EmailBison's order; Bounces fetches folder=bounced and shows the Bounce chip", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderInbox();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Inbox",
      "Sent",
      "Spam",
      "Bounces",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Bounces" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("folder=bounced"))).toBe(true),
    );
    await screen.findByText("Bounce");
    expect(screen.getByRole("tab", { name: "Bounces" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("the status filter passes through and resets to page 1", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderInbox();

    await user.selectOptions(
      screen.getByLabelText("Reply filter"),
      "interested",
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.includes("status=interested") && c.url.includes("page=1"),
        ),
      ).toBe(true),
    );
  });

  test("paginates through the server meta", async () => {
    const { calls } = installFetch();
    const user = userEvent.setup();
    await renderInbox();

    expect(screen.getByText("page 1 of 3 · 60 replies")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("page=2"))).toBe(true),
    );
  });

  test("a failed folder load keeps loaded rows visible and Retry refetches", async () => {
    let sentFails = true;
    const { calls } = installFetch((url) => {
      if (url.includes("folder=sent") && sentFails) {
        sentFails = false;
        return json({ error: "bison down" }, 502);
      }
      if (url.includes("folder=sent")) {
        return json({
          connected: true,
          replies: [READ_PLAIN],
          meta: { currentPage: 1, lastPage: 1, total: 1 },
        });
      }
      return null;
    });
    const user = userEvent.setup();
    await renderInbox();

    await user.click(screen.getByRole("tab", { name: "Sent" }));
    await screen.findByText(/bison down/);
    // The previously loaded rows are still on screen.
    expect(
      screen.getByText("Ada Lovelace — ada@example.com"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.includes("folder=sent")).length,
      ).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(screen.queryByText(/bison down/)).not.toBeInTheDocument(),
    );
  });

  test("not connected renders the honest note and never fetches replies", async () => {
    const { calls } = installFetch((url) =>
      url.startsWith("/api/email/connection")
        ? json({ provisioned: true, connected: false })
        : null,
    );
    render(<RepliesList />);

    await screen.findByText("Not connected — link EmailBison on the Campaigns tab.");
    expect(calls.some((c) => c.url.startsWith("/api/email/replies"))).toBe(
      false,
    );
  });

  test("connection status failure reports honestly", async () => {
    installFetch((url) =>
      url.startsWith("/api/email/connection")
        ? json({ error: "secrets unavailable" }, 502)
        : null,
    );
    render(<RepliesList />);
    await screen.findByText(/EmailBison status unavailable: secrets unavailable/);
  });

  test("links out with the EmailBison name", async () => {
    installFetch();
    await renderInbox();
    expect(
      screen.getByRole("link", { name: "Open in EmailBison ↗" }),
    ).toHaveAttribute("href", "https://dedi.emailbison.com");
  });
});
