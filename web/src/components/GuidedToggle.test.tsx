import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuidedToggle } from "./GuidedToggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.guided;
});

describe("GuidedToggle", () => {
  it("renders a single graduation-cap button, off by default", () => {
    render(<GuidedToggle />);
    const btn = screen.getByRole("button", { name: /turn guided mode on/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("built from the .surface primitive so it honors the surface tokens", () => {
    const { container } = render(<GuidedToggle />);
    expect(container.querySelectorAll(".surface").length).toBeGreaterThan(0);
  });

  it("clicking turns guided mode on: data-guided, persistence, pressed state", async () => {
    const user = userEvent.setup();
    render(<GuidedToggle />);
    await user.click(screen.getByRole("button", { name: /turn guided mode on/i }));
    expect(document.documentElement.dataset.guided).toBe("on");
    expect(localStorage.getItem("mh-guided")).toBe("on");
    const btn = screen.getByRole("button", { name: /turn guided mode off/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn.className).toContain("on");
  });

  it("clicking again turns it off and removes the attribute", async () => {
    const user = userEvent.setup();
    render(<GuidedToggle />);
    await user.click(screen.getByRole("button", { name: /turn guided mode on/i }));
    await user.click(screen.getByRole("button", { name: /turn guided mode off/i }));
    expect(document.documentElement.dataset.guided).toBeUndefined();
    expect(localStorage.getItem("mh-guided")).toBe("off");
    expect(
      screen.getByRole("button", { name: /turn guided mode on/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});
