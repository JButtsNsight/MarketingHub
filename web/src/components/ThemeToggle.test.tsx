import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeToggle", () => {
  it("renders a single sun/moon icon toggle and nothing else", () => {
    render(<ThemeToggle />);
    // Light is the default, so the button offers the switch TO dark.
    expect(
      screen.getByRole("button", { name: /switch to dark theme/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // The old segmented Light/Dark labels are gone.
    expect(screen.queryByText(/^light$/i)).toBeNull();
    expect(screen.queryByText(/^dark$/i)).toBeNull();
    // Retired options stay retired.
    expect(screen.queryByRole("button", { name: /supabase/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /glass|flat/i })).toBeNull();
  });

  it("built from the .surface primitive so it honors the surface tokens", () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelectorAll(".surface").length).toBeGreaterThan(0);
  });

  it("clicking flips to dark: sets data-theme, persists, and offers the way back", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(
      screen.getByRole("button", { name: /switch to dark theme/i }),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("mh-theme")).toBe("dark");
    expect(
      screen.getByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("clicking twice round-trips back to light", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(
      screen.getByRole("button", { name: /switch to dark theme/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /switch to light theme/i }),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("mh-theme")).toBe("light");
  });
});
