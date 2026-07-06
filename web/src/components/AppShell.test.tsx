import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AppShell } from "./AppShell";

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

  it("does not use a banned centered three-card hero or violet gradient", () => {
    const { container } = render(
      <AppShell>
        <p>body</p>
      </AppShell>,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain("backdrop-filter");
    expect(html).not.toContain("violet");
    expect(html).not.toContain("indigo");
  });
});
