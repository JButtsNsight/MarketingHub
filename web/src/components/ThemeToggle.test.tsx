import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeToggle", () => {
  it("renders the Light/Dark segmented control and nothing else", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
    // The glass/flat skin toggle is gone — the app is flat-only.
    expect(screen.queryByRole("button", { name: /glass/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /flat/i })).toBeNull();
  });

  it("built from the .surface primitive so it honors the surface tokens", () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelectorAll(".surface").length).toBeGreaterThan(0);
  });

  it("clicking Dark sets data-theme=dark on <html>", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: /dark/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("mh-theme")).toBe("dark");
  });

  it("marks the active option with aria-pressed", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: /dark/i }));
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
