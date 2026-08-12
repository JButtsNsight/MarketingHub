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
  it("renders the MARKETING HUB wordmark in the display face, with no Nsight element", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const mark = screen.getByText(/marketing hub/i);
    // The wordmark uses the .word class, which maps to var(--fd) = Geist Sans
    // (letterspaced all-caps via CSS).
    expect(mark.closest(".word")).not.toBeNull();
    expect(screen.queryByText(/nsight/i)).toBeNull();
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

  it("renders the sun/moon theme toggle without the retired skin toggle", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    expect(
      screen.getByRole("button", { name: /switch to dark theme/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /glass/i })).toBeNull();
  });

  it("hides the Admin nav group unless admin (display filter; routes enforce)", () => {
    render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: /authentication/i })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /infrastructure/i })).toBeNull();
  });

  it("shows the Admin nav group when admin", () => {
    render(
      <AppShell admin>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    expect(
      within(nav).getByRole("link", { name: /authentication/i }),
    ).toHaveAttribute("href", "/admin/auth");
    expect(within(nav).getByRole("link", { name: /logs/i })).toHaveAttribute(
      "href",
      "/logs",
    );
  });

  it("threads sections down to the nav (display filter; routes enforce)", () => {
    render(
      <AppShell sections={[]}>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: /table editor/i })).toBeNull();
    expect(
      within(nav).queryByRole("link", { name: /competitor intel/i }),
    ).toBeNull();
    expect(
      within(nav).getByRole("link", { name: /sms campaigns/i }),
    ).toBeInTheDocument();
  });

  it("threads the marketing tier down to the nav (section-only rail keeps its section)", () => {
    render(
      <AppShell sections={["platform"]} marketing={false}>
        <p>body</p>
      </AppShell>,
    );
    const nav = screen.getByRole("navigation");
    expect(
      within(nav).getByRole("link", { name: /table editor/i }),
    ).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /overview/i })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /sms campaigns/i })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /settings/i })).toBeNull();
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
