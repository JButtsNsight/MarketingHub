import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setGuided } from "@/lib/guided";
import { Guide } from "./Guide";

// A real registry id seeded in lib/guides/nav.ts.
const KNOWN_ID = "nav.shell.guided-toggle";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.guided;
});

describe("Guide", () => {
  it("renders children untouched and never opens while guided mode is off", async () => {
    const user = userEvent.setup();
    render(
      <Guide id={KNOWN_ID}>
        <button type="button">Target</button>
      </Guide>,
    );
    expect(screen.getByRole("button", { name: "Target" })).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "Target" }));
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hover raises the popover with the registry copy while guided is on", async () => {
    setGuided(true);
    const user = userEvent.setup();
    render(
      <Guide id={KNOWN_ID}>
        <button type="button">Target</button>
      </Guide>,
    );
    await user.hover(screen.getByRole("button", { name: "Target" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/guided mode/i);
    expect(tip).toHaveTextContent(/rest your pointer/i);
  });

  it("unhover dismisses", async () => {
    setGuided(true);
    const user = userEvent.setup();
    render(
      <Guide id={KNOWN_ID}>
        <button type="button">Target</button>
      </Guide>,
    );
    await user.hover(screen.getByRole("button", { name: "Target" }));
    await screen.findByRole("tooltip");
    await user.unhover(screen.getByRole("button", { name: "Target" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keyboard focus opens immediately; Escape dismisses", async () => {
    setGuided(true);
    const user = userEvent.setup();
    render(
      <Guide id={KNOWN_ID}>
        <button type="button">Target</button>
      </Guide>,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Target" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("flipping guided off closes an open popover", async () => {
    setGuided(true);
    const user = userEvent.setup();
    render(
      <Guide id={KNOWN_ID}>
        <button type="button">Target</button>
      </Guide>,
    );
    await user.hover(screen.getByRole("button", { name: "Target" }));
    await screen.findByRole("tooltip");
    setGuided(false);
    await vi.waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("an unknown id renders children only and logs loudly", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setGuided(true);
    const user = userEvent.setup();
    const { container } = render(
      <Guide id="nope.not.real">
        <button type="button">Target</button>
      </Guide>,
    );
    expect(container.querySelector(".guide-wrap")).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('unknown guide id "nope.not.real"'),
    );
    await user.hover(screen.getByRole("button", { name: "Target" }));
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole("tooltip")).toBeNull();
    spy.mockRestore();
  });
});
