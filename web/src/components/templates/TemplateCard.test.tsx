import { describe, expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TemplateCard } from "./TemplateCard";
import type { Template } from "@/lib/templates/schema";

const base: Template = {
  id: "t1",
  name: "Spring Promo",
  type: "email",
  category: "Promotion",
  tags: ["sale", "spring"],
  subject: "Big spring sale",
  body: "<h1>Sale</h1>",
  storage_path: null,
  created_by: "amy@nsight.example",
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:00:00Z",
};

describe("TemplateCard", () => {
  test("links to the template detail page", () => {
    render(<TemplateCard template={base} />);
    const link = screen.getByRole("link", { name: /spring promo/i });
    expect(link).toHaveAttribute("href", "/templates/t1");
  });

  test("shows the name in the display face (.tpl-name)", () => {
    render(<TemplateCard template={base} />);
    expect(screen.getByText("Spring Promo").closest(".tpl-name")).not.toBeNull();
  });

  test("renders a category chip colored from the data pool by position (never red)", () => {
    render(<TemplateCard template={base} />);
    const chip = screen.getByText("Promotion");
    const style = chip.getAttribute("style") ?? "";
    // Promotion is index 1 in the starter list → --data-2
    expect(style).toContain("--data-2");
    expect(style).not.toContain("--fail");
    expect(style.toLowerCase()).not.toContain("red");
  });

  test("renders a type badge and the tag chips", () => {
    render(<TemplateCard template={base} />);
    expect(screen.getByText(/email/i)).toBeInTheDocument();
    expect(screen.getByText("sale")).toBeInTheDocument();
    expect(screen.getByText("spring")).toBeInTheDocument();
  });

  test("renders created_at in a mono <time> element", () => {
    render(<TemplateCard template={base} />);
    const time = screen.getByText(/2026-07-05/);
    expect(time.tagName.toLowerCase()).toBe("time");
    expect(time).toHaveClass("mono");
    expect(time).toHaveAttribute("dateTime", base.created_at);
  });

  test("is built on the .surface primitive", () => {
    const { container } = render(<TemplateCard template={base} />);
    expect(container.querySelector(".surface")).not.toBeNull();
  });
});
