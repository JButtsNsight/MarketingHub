import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replace = vi.fn();
const h = vi.hoisted(() => ({ params: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(h.params),
}));

import { FilterChips } from "./FilterChips";

describe("FilterChips", () => {
  beforeEach(() => {
    replace.mockReset();
    h.params = "";
  });

  test("clicking a category chip sets the category param", async () => {
    const user = userEvent.setup();
    render(<FilterChips />);
    await user.click(screen.getByRole("button", { name: "Promotion" }));
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("category=Promotion");
  });

  test("clicking the active category chip clears the category param", async () => {
    h.params = "category=Promotion";
    const user = userEvent.setup();
    render(<FilterChips />);
    await user.click(screen.getByRole("button", { name: "Promotion" }));
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).not.toContain("category=Promotion");
  });

  test("clicking a type chip sets the type param", async () => {
    const user = userEvent.setup();
    render(<FilterChips />);
    await user.click(screen.getByRole("button", { name: /^email$/i }));
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("type=email");
  });

  test("category chips are colored from the data pool by position (never red)", () => {
    render(<FilterChips />);
    const promo = screen.getByRole("button", { name: "Promotion" });
    const style = promo.getAttribute("style") ?? "";
    expect(style).toContain("--data-2");
    expect(style.toLowerCase()).not.toContain("red");
  });

  test("reflects the active category from the URL as pressed", () => {
    h.params = "category=Newsletter";
    render(<FilterChips />);
    expect(
      screen.getByRole("button", { name: "Newsletter" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
