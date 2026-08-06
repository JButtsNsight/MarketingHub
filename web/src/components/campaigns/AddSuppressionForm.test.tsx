import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { AddSuppressionForm } from "./AddSuppressionForm";

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

describe("AddSuppressionForm", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("collapsed to a button; expanding shows phone + note fields", async () => {
    const user = userEvent.setup();
    render(<AddSuppressionForm />);

    await user.click(screen.getByRole("button", { name: /suppress a number/i }));

    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/why/i)).toBeInTheDocument();
  });

  test("POSTs phone + note, then collapses and refreshes", async () => {
    const fetchFn = mockFetch(201, { suppression: {} });
    const user = userEvent.setup();
    render(<AddSuppressionForm />);

    await user.click(screen.getByRole("button", { name: /suppress a number/i }));
    await user.type(screen.getByLabelText(/phone/i), "(555) 000-0006");
    await user.type(screen.getByLabelText(/why/i), "asked by phone");
    await user.click(screen.getByRole("button", { name: /^suppress$/i }));

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/suppressions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      phone: "(555) 000-0006",
      note: "asked by phone",
    });
    expect(refresh).toHaveBeenCalled();
    // collapsed again
    expect(
      screen.getByRole("button", { name: /suppress a number/i }),
    ).toBeInTheDocument();
  });

  test("empty phone never issues a request", async () => {
    const fetchFn = mockFetch(201);
    const user = userEvent.setup();
    render(<AddSuppressionForm />);

    await user.click(screen.getByRole("button", { name: /suppress a number/i }));
    await user.click(screen.getByRole("button", { name: /^suppress$/i }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a phone/i);
  });

  test("409 says the number is already covered", async () => {
    mockFetch(409, { error: "Phone is already suppressed" });
    const user = userEvent.setup();
    render(<AddSuppressionForm />);

    await user.click(screen.getByRole("button", { name: /suppress a number/i }));
    await user.type(screen.getByLabelText(/phone/i), "5550000006");
    await user.click(screen.getByRole("button", { name: /^suppress$/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/already on the/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("400 surfaces the server's validation message", async () => {
    mockFetch(400, { error: "Not a usable US phone number" });
    const user = userEvent.setup();
    render(<AddSuppressionForm />);

    await user.click(screen.getByRole("button", { name: /suppress a number/i }));
    await user.type(screen.getByLabelText(/phone/i), "123");
    await user.click(screen.getByRole("button", { name: /^suppress$/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/US phone/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
