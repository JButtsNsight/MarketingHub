import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { TemplateGrid } from "./TemplateGrid";
import type { Template } from "@/lib/templates/schema";

function tpl(id: string, name: string): Template {
  return {
    id,
    name,
    type: "text",
    category: "Newsletter",
    tags: [],
    subject: null,
    body: "hi",
    storage_path: null,
    created_by: "amy@nsight.example",
    created_at: "2026-07-05T12:00:00Z",
    updated_at: "2026-07-05T12:00:00Z",
  };
}

describe("TemplateGrid", () => {
  test("renders one card per template", () => {
    render(
      <TemplateGrid templates={[tpl("a", "Alpha"), tpl("b", "Beta")]} />,
    );
    expect(screen.getByRole("link", { name: /alpha/i })).toHaveAttribute(
      "href",
      "/templates/a",
    );
    expect(screen.getByRole("link", { name: /beta/i })).toHaveAttribute(
      "href",
      "/templates/b",
    );
  });
});
