import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SmsSuppression } from "@/lib/sms/schema";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { SuppressionsTable } from "./SuppressionsTable";

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const stopEntry: SmsSuppression = {
  phone_e164: "+15550000001",
  reason: "stop",
  raw: { type: "UNSUBSCRIBE" },
  created_at: "2026-08-01T12:00:00Z",
};

const manualEntry: SmsSuppression = {
  phone_e164: "+15550000006",
  reason: "manual",
  raw: { added_by: "amy@nsight.example", note: "asked by phone" },
  created_at: "2026-08-05T12:00:00Z",
};

describe("SuppressionsTable", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders provenance: STOP entries from the webhook, manual with who/why", () => {
    render(<SuppressionsTable suppressions={[stopEntry, manualEntry]} />);
    expect(screen.getByText("STOP (texted)")).toBeInTheDocument();
    expect(screen.getByText("webhook")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("amy@nsight.example")).toBeInTheDocument();
    expect(screen.getByText("asked by phone")).toBeInTheDocument();
  });

  test("STOP entries carry no remove action; manual entries do", () => {
    render(<SuppressionsTable suppressions={[stopEntry, manualEntry]} />);
    // exactly one Remove button — the manual row's
    expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(1);
  });

  test("removal is two-click: arm, then confirm DELETEs and refreshes", async () => {
    const fetchFn = mockFetch(204);
    const user = userEvent.setup();
    render(<SuppressionsTable suppressions={[manualEntry]} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(fetchFn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm remove/i }));

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`/api/suppressions/${encodeURIComponent("+15550000006")}`);
    expect(init?.method).toBe("DELETE");
    expect(refresh).toHaveBeenCalled();
  });

  test("Keep disarms without any request", async () => {
    const fetchFn = mockFetch(204);
    const user = userEvent.setup();
    render(<SuppressionsTable suppressions={[manualEntry]} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await user.click(screen.getByRole("button", { name: /keep/i }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^remove$/i }),
    ).toBeInTheDocument();
  });

  test("a 409 surfaces the server's explanation", async () => {
    mockFetch(409, { error: "STOP entries are permanent" });
    const user = userEvent.setup();
    render(<SuppressionsTable suppressions={[manualEntry]} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await user.click(screen.getByRole("button", { name: /confirm remove/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/permanent/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
