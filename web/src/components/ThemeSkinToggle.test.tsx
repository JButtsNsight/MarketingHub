import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeSkinToggle } from "./ThemeSkinToggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.skin;
});

describe("ThemeSkinToggle", () => {
  it("renders theme (Light/Dark) and skin (Glass/Flat) segmented controls", () => {
    render(<ThemeSkinToggle />);
    expect(screen.getByRole("button", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /glass/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /flat/i })).toBeInTheDocument();
  });

  it("built from the .surface primitive so it honors the global skin", () => {
    const { container } = render(<ThemeSkinToggle />);
    expect(container.querySelectorAll(".surface").length).toBeGreaterThan(0);
  });

  it("clicking Dark sets data-theme=dark on <html>", async () => {
    const user = userEvent.setup();
    render(<ThemeSkinToggle />);
    await user.click(screen.getByRole("button", { name: /dark/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("mh-theme")).toBe("dark");
  });

  it("clicking Flat sets data-skin=flat on <html>", async () => {
    const user = userEvent.setup();
    render(<ThemeSkinToggle />);
    await user.click(screen.getByRole("button", { name: /flat/i }));
    expect(document.documentElement.dataset.skin).toBe("flat");
    expect(localStorage.getItem("mh-skin")).toBe("flat");
  });

  it("marks the active option with aria-pressed", async () => {
    const user = userEvent.setup();
    render(<ThemeSkinToggle />);
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
