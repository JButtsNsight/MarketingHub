import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Template } from "@/lib/templates/schema";
import type { ContactList } from "@/lib/contacts/schema";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { NewCampaignForm, PHI_WARNING } from "./NewCampaignForm";

const CLEAN_ID = "11111111-1111-4111-8111-111111111111";
const DIRTY_ID = "22222222-2222-4222-8222-222222222222";
const CSV_LIST_ID = "33333333-3333-4333-8333-333333333333";
const MONDAY_LIST_ID = "44444444-4444-4444-8444-444444444444";

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

const LISTS: ContactList[] = [
  {
    id: CSV_LIST_ID,
    name: "August recall patients",
    source: "csv",
    storage_path: `${CSV_LIST_ID}/patients.csv`,
    original_filename: "patients.csv",
    monday_board_id: null,
    monday_board_name: null,
    monday_phone_column_id: null,
    contact_count: 42,
    invalid_count: 3,
    duplicate_count: 1,
    created_by: "amy@nsight.example",
    created_at: "2026-07-28T12:00:00Z",
    updated_at: "2026-07-28T12:00:00Z",
  },
  {
    id: MONDAY_LIST_ID,
    name: "Wellness board",
    source: "monday",
    storage_path: null,
    original_filename: null,
    monday_board_id: "4567890123",
    monday_board_name: "Patient list",
    monday_phone_column_id: "phone_col",
    contact_count: 0,
    invalid_count: 0,
    duplicate_count: 0,
    created_by: "amy@nsight.example",
    created_at: "2026-07-28T12:00:00Z",
    updated_at: "2026-07-28T12:00:00Z",
  },
];

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

/** Fetch stub that rejects at the network level (fetch's TypeError). */
function stubFetchReject() {
  const fn = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
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

/** Fill every field with valid values (CSV list unless told otherwise). */
async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  listId: string = CSV_LIST_ID,
) {
  await user.type(screen.getByLabelText(/campaign name/i), "August recall");
  await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
  await user.selectOptions(screen.getByLabelText(/contact list/i), listId);
  fireEvent.change(screen.getByLabelText(/send date/i), {
    target: { value: "2030-01-15" },
  });
}

describe("NewCampaignForm", () => {
  beforeEach(() => {
    push.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders name, template, contact list, and date fields on a .surface", () => {
    const { container } = render(
      <NewCampaignForm templates={TEMPLATES} lists={LISTS} />,
    );
    expect(screen.getByLabelText(/campaign name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/template/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/contact list/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send date/i)).toBeInTheDocument();
    expect(container.querySelector(".surface")).not.toBeNull();
  });

  test("shows the permanent PHI warning with the exact governed copy", () => {
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    expect(PHI_WARNING).toBe(
      "SimpleTexting has not signed a BAA. Message content must contain NO PHI — no conditions, medications, appointment or treatment details. Keep it generic.",
    );
    expect(screen.getByText(PHI_WARNING)).toBeInTheDocument();
  });

  test("the send-date input is floored at today in America/New_York", () => {
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    expect(screen.getByLabelText(/send date/i)).toHaveAttribute(
      "min",
      todayInEastern(),
    );
  });

  test("selecting a template previews its body", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    expect(
      screen.getByText(/hi \{\{firstName\}\}, time for a visit/i),
    ).toBeInTheDocument();
  });

  test("flags a template whose body has unsupported merge fields", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    await user.selectOptions(screen.getByLabelText(/template/i), DIRTY_ID);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/unsupported merge field/i);
    expect(alert).toHaveTextContent(/lastName/);
  });

  test("list options label their source (sheet count vs live Monday board)", () => {
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    const select = screen.getByLabelText(/contact list/i);
    expect(select).toHaveTextContent(/sheet, 42 contacts/i);
    expect(select).toHaveTextContent(/Monday: Patient list \(live\)/i);
  });

  test("selecting a csv list shows its usable-contact summary", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    await user.selectOptions(
      screen.getByLabelText(/contact list/i),
      CSV_LIST_ID,
    );
    expect(screen.getByText(/usable contacts from/i)).toBeInTheDocument();
    expect(screen.getByText("patients.csv")).toBeInTheDocument();
  });

  test("selecting a monday list explains live fetching", async () => {
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);
    await user.selectOptions(
      screen.getByLabelText(/contact list/i),
      MONDAY_LIST_ID,
    );
    expect(
      screen.getByText(/recipients are fetched live at creation/i),
    ).toBeInTheDocument();
  });

  test("blocks submit until a contact list is chosen", async () => {
    const fetchFn = stubFetch({});
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await user.type(screen.getByLabelText(/campaign name/i), "August recall");
    await user.selectOptions(screen.getByLabelText(/template/i), CLEAN_ID);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/choose a contact list/i);
  });

  test("posts a valid campaign and redirects", async () => {
    const fetchFn = stubFetch({
      "/api/campaigns": {
        status: 201,
        body: { id: "camp-9", counts: { pending: 42, skipped: 0, suppressed: 0, total: 42 } },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    const create = fetchFn.mock.calls.find(([u]) => u === "/api/campaigns");
    expect(create).toBeDefined();
    expect(create?.[1]?.method).toBe("POST");
    expect(JSON.parse(create?.[1]?.body as string)).toEqual({
      name: "August recall",
      templateId: CLEAN_ID,
      contactListId: CSV_LIST_ID,
      sendDate: "2030-01-15",
    });
    expect(push).toHaveBeenCalledWith("/campaigns/camp-9");
  });

  test("after a 201 the submit button STAYS disabled while navigation is pending", async () => {
    // router.push is async — re-enabling the button on success opens a
    // double-submit window that double-creates the campaign.
    stubFetch({
      "/api/campaigns": { status: 201, body: { id: "camp-9" } },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user);
    const submit = screen.getByRole("button", { name: /create campaign/i });
    await user.click(submit);

    expect(push).toHaveBeenCalledWith("/campaigns/camp-9");
    expect(submit).toBeDisabled();
  });

  test("a 409 duplicate-campaign response shows a clear duplicate message", async () => {
    stubFetch({
      "/api/campaigns": { status: 409, body: { error: "duplicate-campaign" } },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user);
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
      "/api/campaigns": {
        status: 400,
        body: { error: "sendDate must be in the future (11:30 AM Eastern)" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /sendDate must be in the future/i,
    );
    expect(push).not.toHaveBeenCalled();
  });

  test("a 503 create (monday list, token unset) surfaces the configuration error", async () => {
    stubFetch({
      "/api/campaigns": {
        status: 503,
        body: { error: "monday-not-configured" },
      },
    });
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user, MONDAY_LIST_ID);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /MONDAY_API_TOKEN/,
    );
    expect(push).not.toHaveBeenCalled();
  });

  test("a network-level create failure shows an error and re-enables submit", async () => {
    stubFetchReject();
    const user = userEvent.setup();
    render(<NewCampaignForm templates={TEMPLATES} lists={LISTS} />);

    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /create campaign/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /network error — please try again/i,
    );
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /create campaign/i }),
    ).toBeEnabled();
  });
});
