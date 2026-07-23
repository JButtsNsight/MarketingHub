import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Template } from "@/lib/templates/schema";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { NewCampaignForm, PHI_WARNING } from "./NewCampaignForm";

const CLEAN_ID = "11111111-1111-4111-8111-111111111111";
const DIRTY_ID = "22222222-2222-4222-8222-222222222222";

function tpl(id: string, name: string, body: string): Template {
  return {
    id,
    name,
    type: "text",
    category: "Reminder",
    tags: [],
    subject: null,
    body,
    storage_path: null,
    created_by: "amy@nsight.example",
    created_at: "2026-07-05T12:00:00Z",
    updated_at: "2026-07-05T12:00:00Z",
  };
}

const TEMPLATES: Template[] = [
  tpl(CLEAN_ID, "Checkup reminder", "Hi {{firstName}}, time for a visit."),
  tpl(DIRTY_ID, "Broken merge", "Hi {{firstName}} {{lastName}}!"),
];

const PREVIEW = {
  boardId: "4567890123",
  boardName: "Patient list",
  columns: [
    { id: "name_col", title: "Name", type: "name" },
    { id: "notes_col", title: "Notes", type: "text" },
    { id: "phone_col", title: "Phone", type: "phone" },
  ],
  phoneColumns: [{ id: "phone_col", title: "Phone", type: "phone" }],
  suggestedPhoneColumnId: "phone_col",
  sample: [
    { name: "Jane Doe", phoneE164: "+15559234567", reason: "ok" },
    { name: "No Phone", phoneE164: null, reason: "invalid" },
  ],
  pageCounts: { fetched: 4, valid: 2, invalid: 1, duplicate: 1 },
};

type Route = { status: number; body: unknown };

/** Fetch stub routed by URL prefix; throws on anything unexpected. */
function stubFetch(routes: Record<string, Route>) {
  const fn = vi.fn((url: string, _init?: RequestInit) => {
    const hit = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    const { status, body } = hit[1];
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * Fetch stub routed by URL prefix where each route either resolves with a
 * response or rejects at the network level (fetch's TypeError).
 */
function stubFetchWithRejects(
  routes: Record<string, Route | { reject: true }>,
) {
  const fn = vi.fn((url: string, _init?: RequestInit) => {
    const hit = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    const route = hit[1];
    if ("reject" in route) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: () => Promise.resolve(route.body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Today in America/New_York as YYYY-MM-DD (the date input's floor). */
function todayInEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function loadBoard(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText(/monday board/i),
    "https://acme.monday.com/boards/4567890123/views/9",
  );
  await user.click(screen.getByRole("button", { name: /load board/i }));
  await screen.findByLabelText(/phone column/i);
}

describe("NewCampaignForm", () => {
  beforeEach(() => {
    push.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders name, template, board, and date fields on a .surface", () => {
    const { container } = render(<NewCampaignForm templates={TEMPLATES} />);
    expect(screen.getByLabelText(/campaign name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/template/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/monday board/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send date/i)).toBeInTheDocument();
    expect(container.querySelector(".surface")).not.toBeNull();
  });

  test("shows the permanent PHI warning with the exact governed copy", () => {
    render(<NewCampaignForm templates={TEMPLATES} />);
    expect(PHI_WARNING).toBe(
      "SimpleTexting has not signed a BAA. Message content must contain NO PHI — no conditions, medications, appointment or treatment details. Keep it generic.",
    );
    expect(screen.getByText(PHI_WARNING)).toBeInTheDocument();
  });

  test("the send-date input is floored at today in America/New_York", () => {
    render(<NewCampaignForm templates={TEMPLATES} />);
    expect(screen.getByLabelText(/send date/i)).toHaveAttribute(
      "min",
      todayInEastern(),
    );
  });

  test("selecting a template previews its body", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    expect(
      screen.getByText(/hi \{\{firstName\}\}, time for a visit/i),
    ).toBeInTheDocument();
  });

  test("flags a template whose body has unsupported merge fields", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);
    await user.selectOptions(screen.getByLabelText(/template/i), DIRTY_ID);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/unsupported merge field/i);
    expect(alert).toHaveTextContent(/lastName/);
  });

  test("Load board posts the raw input and renders columns, sample, and counts", async () => {
    const fetchFn = stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);
    await loadBoard(user);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/monday/board-preview");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      board: "https://acme.monday.com/boards/4567890123/views/9",
    });

    // Board identity + classified sample + whole-page counts.
    expect(screen.getByText(/patient list/i)).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("+15559234567")).toBeInTheDocument();
    expect(screen.getByText(/4 fetched/i)).toBeInTheDocument();
    expect(screen.getByText(/2 valid/i)).toBeInTheDocument();
    expect(screen.getByText(/1 invalid/i)).toBeInTheDocument();
    expect(screen.getByText(/1 duplicate/i)).toBeInTheDocument();

    // The suggested phone column is pre-selected, phone columns listed first,
    // but every column stays choosable (some boards keep phones in text cols).
    const select = screen.getByLabelText(/phone column/i) as HTMLSelectElement;
    expect(select.value).toBe("phone_col");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      "phone_col",
      "name_col",
      "notes_col",
    ]);
  });

  test("a 503 preview surfaces the Monday configuration error", async () => {
    stubFetch({
      "/api/monday/board-preview": {
        status: 503,
        body: { error: "monday-not-configured" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);
    await user.type(screen.getByLabelText(/monday board/i), "4567890123");
    await user.click(screen.getByRole("button", { name: /load board/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /MONDAY_API_TOKEN/,
    );
  });

  test("a network-level board-preview failure shows an error, no unhandled rejection", async () => {
    stubFetchWithRejects({ "/api/monday/board-preview": { reject: true } });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/monday board/i), "4567890123");
    await user.click(screen.getByRole("button", { name: /load board/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /network error — please try again/i,
    );
    // The busy flag resets so the user can retry.
    expect(screen.getByRole("button", { name: /load board/i })).toBeEnabled();
  });

  test("a network-level create failure shows an error and re-enables submit", async () => {
    stubFetchWithRejects({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": { reject: true },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /network error — please try again/i,
    );
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /create campaign/i }),
    ).toBeEnabled();
  });

  test("blocks submit until a board is loaded and a phone column chosen", async () => {
    const fetchFn = stubFetch({});
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/load the board/i);
  });

  test("posts a valid campaign (board URL reduced to its id) and redirects", async () => {
    const fetchFn = stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": {
        status: 201,
        body: { id: "camp-9", counts: { pending: 2, skipped: 1, suppressed: 0, total: 3 } },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    const create = fetchFn.mock.calls.find(([u]) => u === "/api/campaigns");
    expect(create).toBeDefined();
    expect(create?.[1]?.method).toBe("POST");
    expect(JSON.parse(create?.[1]?.body as string)).toEqual({
      name: "August recall",
      templateId: CLEAN_ID,
      mondayBoardId: "4567890123",
      mondayPhoneColumnId: "phone_col",
      sendDate: "2030-01-15",
    });
    expect(push).toHaveBeenCalledWith("/campaigns/camp-9");
  });

  test("after a 201 the submit button STAYS disabled while navigation is pending", async () => {
    // router.push is async — re-enabling the button on success opens a
    // double-submit window that double-creates the campaign.
    stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": { status: 201, body: { id: "camp-9" } },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    const submit = screen.getByRole("button", { name: /create campaign/i });
    await user.click(submit);

    expect(push).toHaveBeenCalledWith("/campaigns/camp-9");
    expect(submit).toBeDisabled();
  });

  test("a 409 duplicate-campaign response shows a clear duplicate message", async () => {
    stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": {
        status: 409,
        body: { error: "duplicate-campaign" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/an identical campaign already exists/i);
    // The raw server slug is not user-facing copy.
    expect(alert).not.toHaveTextContent(/^duplicate-campaign$/);
    expect(push).not.toHaveBeenCalled();
    // Error path — the button is usable again after the fix.
    expect(
      screen.getByRole("button", { name: /create campaign/i }),
    ).toBeEnabled();
  });

  test("surfaces the server's 400 error message on create", async () => {
    stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": {
        status: 400,
        body: { error: "sendDate must be in the future (11:30 AM Eastern)" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /sendDate must be in the future/i,
    );
    expect(push).not.toHaveBeenCalled();
  });

  test("a 503 create surfaces the configuration error", async () => {
    stubFetch({
      "/api/monday/board-preview": { status: 200, body: PREVIEW },
      "/api/campaigns": {
        status: 503,
        body: { error: "monday-not-configured" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await loadBoard(user);
    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-15" },
    });
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /MONDAY_API_TOKEN/,
    );
    expect(push).not.toHaveBeenCalled();
  });
});
