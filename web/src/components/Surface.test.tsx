import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Surface } from "./Surface";

describe("Surface", () => {
  it("renders children", () => {
    render(<Surface>hello glass</Surface>);
    expect(screen.getByText("hello glass")).toBeInTheDocument();
  });

  it("applies the .surface class so it consumes the surface tokens", () => {
    render(<Surface data-testid="s">x</Surface>);
    expect(screen.getByTestId("s")).toHaveClass("surface");
  });

  it("passes a data-elevated attribute", () => {
    render(<Surface data-testid="s">x</Surface>);
    expect(screen.getByTestId("s")).toHaveAttribute("data-elevated", "true");
  });

  it("adds the glint class only when glint is requested (large surfaces)", () => {
    const { rerender } = render(
      <Surface data-testid="s">x</Surface>,
    );
    expect(screen.getByTestId("s")).not.toHaveClass("glint");
    rerender(
      <Surface data-testid="s" glint>
        x
      </Surface>,
    );
    expect(screen.getByTestId("s")).toHaveClass("glint");
  });

  it("merges caller className and never sets an inline backdrop-filter", () => {
    render(
      <Surface data-testid="s" className="panel">
        x
      </Surface>,
    );
    const el = screen.getByTestId("s") as HTMLElement;
    expect(el).toHaveClass("surface", "panel");
    expect(el.style.backdropFilter || "").toBe("");
    expect(el.getAttribute("style") ?? "").not.toContain("backdrop-filter");
  });
});
