import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  PoliciesClient,
  type PolicyDto,
  type PolicyTableDto,
  type PolicyTemplateDto,
} from "./PoliciesClient";

const TABLES: PolicyTableDto[] = [
  { schema: "public", name: "widgets", rlsEnabled: true },
  { schema: "marketinghub", name: "campaigns", rlsEnabled: false },
];

const POLICIES: PolicyDto[] = [
  {
    id: 1,
    schema: "public",
    table: "widgets",
    name: "widgets_admin",
    action: "PERMISSIVE",
    roles: ["service_role"],
    command: "ALL",
    definition: "true",
    check: null,
  },
];

const TEMPLATES: PolicyTemplateDto[] = [
  {
    id: "service_role_full_access",
    name: "Service-role full access",
    description: "Enable RLS and grant service_role unrestricted access.",
    prefill: {
      name: "service_role_full_access",
      command: "ALL",
      action: "PERMISSIVE",
      roles: "service_role",
      using: "true",
      check: "true",
    },
  },
];

/** Route-aware fetch mock: GET reload, POST create, PATCH alter, DELETE drop. */
function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ policies: POLICIES, tables: TABLES }), {
          status: 200,
        }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ created: "service_role_full_access" }), {
          status: 201,
        }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ dropped: "widgets_admin" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderClient() {
  return render(
    <PoliciesClient
      initialTables={TABLES}
      initialPolicies={POLICIES}
      templates={TEMPLATES}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PoliciesClient", () => {
  test("renders coverage + policies with no confirm on browse", () => {
    mockFetchRoutes();
    renderClient();

    // Coverage table shows both tables and their RLS state. "public.widgets"
    // also appears on the policy row, so it is present more than once.
    expect(screen.getAllByText("public.widgets").length).toBeGreaterThan(0);
    expect(screen.getByText("marketinghub.campaigns")).toBeInTheDocument();
    expect(screen.getByText("enabled")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    // The policy row.
    expect(screen.getByText("widgets_admin")).toBeInTheDocument();
    // Just browsing: no interrupting modal.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("selecting a template prefills the create form", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderClient();

    await user.click(screen.getByRole("button", { name: "New policy" }));
    await user.selectOptions(
      screen.getByLabelText("template"),
      "service_role_full_access",
    );

    expect(screen.getByLabelText("name")).toHaveValue("service_role_full_access");
    expect(screen.getByLabelText("roles")).toHaveValue("service_role");
    expect(screen.getByLabelText("using expression")).toHaveValue("true");
  });

  test("creating pops the confirm modal and only POSTs on confirm", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderClient();

    await user.click(screen.getByRole("button", { name: "New policy" }));
    await user.selectOptions(
      screen.getByLabelText("template"),
      "service_role_full_access",
    );
    await user.selectOptions(screen.getByLabelText("table"), "public.widgets");

    // The form's submit button — unique until the dialog opens.
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Create policy" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post!.init!.body as string)).toEqual({
        schema: "public",
        table: "widgets",
        name: "service_role_full_access",
        command: "ALL",
        action: "PERMISSIVE",
        roles: ["service_role"],
        using: "true",
        check: "true",
      });
    });
  });

  test("dropping pops the confirm modal and only DELETEs on confirm", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderClient();

    await user.click(screen.getByRole("button", { name: "Drop" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Drop policy/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Drop policy" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        schema: "public",
        table: "widgets",
        name: "widgets_admin",
      });
    });
  });

  test("cancelling the confirm modal fires no write", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderClient();

    await user.click(screen.getByRole("button", { name: "New policy" }));
    await user.selectOptions(
      screen.getByLabelText("template"),
      "service_role_full_access",
    );
    await user.click(screen.getByRole("button", { name: "Create policy" }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });
});
