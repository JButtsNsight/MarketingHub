import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { UploadForm } from "./UploadForm";
import { TEMPLATE_CATEGORIES } from "@/lib/templates/schema";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("UploadForm", () => {
  beforeEach(() => {
    push.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the core fields including every starter category", () => {
    render(<UploadForm />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^body/i)).toBeInTheDocument();

    const categorySelect = screen.getByLabelText(/category/i);
    for (const cat of TEMPLATE_CATEGORIES) {
      expect(
        within(categorySelect).getByRole("option", { name: cat }),
      ).toBeInTheDocument();
    }
  });

  test("subject only appears for email templates", async () => {
    const user = userEvent.setup();
    render(<UploadForm />);
    // text is the default type → no subject field
    expect(screen.queryByLabelText(/subject/i)).toBeNull();

    await user.selectOptions(screen.getByLabelText(/type/i), "email");
    expect(screen.getByLabelText(/subject/i)).toBeInTheDocument();
  });

  test("adds tag chips from the chip input", async () => {
    const user = userEvent.setup();
    render(<UploadForm />);
    const tagInput = screen.getByLabelText(/tags/i);
    await user.type(tagInput, "Spring{Enter}sale{Enter}");
    expect(screen.getByText("spring")).toBeInTheDocument();
    expect(screen.getByText("sale")).toBeInTheDocument();
  });

  test("blocks submit and shows an error when an email template has no subject", async () => {
    const fetchFn = mockFetch(201, { id: "x" });
    const user = userEvent.setup();
    render(<UploadForm />);

    await user.type(screen.getByLabelText(/name/i), "Welcome");
    await user.selectOptions(screen.getByLabelText(/type/i), "email");
    await user.type(screen.getByLabelText(/^body/i), "Hi there");
    await user.click(screen.getByRole("button", { name: /save|upload|create/i }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByText(/subject is required/i)).toBeInTheDocument();
  });

  test("posts a valid text template and redirects to the new template", async () => {
    const fetchFn = mockFetch(201, { id: "new-123" });
    const user = userEvent.setup();
    render(<UploadForm />);

    await user.type(screen.getByLabelText(/name/i), "Spring Promo");
    await user.selectOptions(screen.getByLabelText(/category/i), "Promotion");
    await user.type(screen.getByLabelText(/tags/i), "sale{Enter}");
    await user.type(screen.getByLabelText(/^body/i), "Big spring sale");
    await user.click(screen.getByRole("button", { name: /save|upload|create/i }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/templates");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toMatchObject({
      name: "Spring Promo",
      type: "text",
      category: "Promotion",
      tags: ["sale"],
      body: "Big spring sale",
    });
    expect(push).toHaveBeenCalledWith("/templates/new-123");
  });

  test("is built on the .surface primitive", () => {
    const { container } = render(<UploadForm />);
    expect(container.querySelector(".surface")).not.toBeNull();
  });
});
