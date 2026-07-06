import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const replace = vi.fn();
const h = vi.hoisted(() => ({ params: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(h.params),
}));

import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  beforeEach(() => {
    replace.mockReset();
    h.params = "";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces input and updates the q query param", () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "spring" } });
    // still within the debounce window → no navigation yet
    expect(replace).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain("q=spring");
    expect(replace.mock.calls[0][0]).toContain("/templates");
  });

  test("only the final value navigates (rapid typing collapses to one call)", () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "sp" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input, { target: { value: "spring" } });
    vi.advanceTimersByTime(400);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain("q=spring");
  });

  test("clearing the box removes the q param", () => {
    h.params = "q=spring";
    render(<SearchBar />);
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "" } });
    vi.advanceTimersByTime(400);

    expect(replace).toHaveBeenCalled();
    expect(replace.mock.calls.at(-1)?.[0]).not.toContain("q=");
  });

  test("preserves existing category/type params when updating q", () => {
    h.params = "category=Promotion";
    render(<SearchBar />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "sale" },
    });
    vi.advanceTimersByTime(400);
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("category=Promotion");
    expect(url).toContain("q=sale");
  });
});
