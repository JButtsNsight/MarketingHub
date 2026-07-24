import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppShell } from "./AppShell";

/** Concatenated app stylesheets with CSS comments stripped, lowercased. */
function appCss(): string {
  const files = ["src/styles/tokens.css", "src/styles/globals.css"];
  return files
    .map((f) => readFileSync(join(process.cwd(), f), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "") // drop comments (they legitimately mention these words)
    .toLowerCase();
}

describe("AppShell", () => {
  it("renders the NSight wordmark in the display face (Marcellus)", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const mark = screen.getByText(/nsight/i);
    // The wordmark uses the .word class, which maps to var(--fd) = Marcellus.
    expect(mark.closest(".word")).not.toBeNull();
  });

  it("renders a left nav containing a Templates link to /templates", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: /templates/i });
    expect(link).toHaveAttribute("href", "/templates");
  });

  it("renders an SMS Campaigns link to /campaigns in the left nav", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: /sms campaigns/i });
    expect(link).toHaveAttribute("href", "/campaigns");
  });

  it("renders the theme/skin toggle", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    expect(screen.getByRole("button", { name: /glass/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
  });

  it("renders children inside a <main> landmark", () => {
    render(
      <AppShell>
        <p>page body here</p>
      </AppShell>,
    );
    const main = screen.getByRole("main");
    expect(within(main).getByText("page body here")).toBeInTheDocument();
  });

  it("uses a left-nav shell layout, not a banned centered three-card hero", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    // A left-nav app frame (nav landmark rendered alongside main) is structurally
    // the opposite of a centered floating three-card hero.
    const nav = screen.getByRole("navigation");
    const main = screen.getByRole("main");
    expect(nav).toBeInTheDocument();
    expect(main).toBeInTheDocument();
    // The hero pattern would center content; the shell renders it in the left-nav grid.
    expect(nav.closest(".app-body")).not.toBeNull();
    expect(main.closest(".app-body")).not.toBeNull();
  });

  it("ships no banned 'Claude look' patterns in the actual stylesheets", () => {
    // Guard the CSS itself (where these would really be reintroduced), not the
    // rendered innerHTML — the component emits only class names, so an innerHTML
    // grep for CSS-only tokens can never fail and gives no protection.
    const css = appCss();
    expect(css).not.toContain("backdrop-filter"); // unfrosted liquid glass
    expect(css).not.toContain("violet"); // no violet/indigo "Claude" gradients
    expect(css).not.toContain("indigo");
  });
});
