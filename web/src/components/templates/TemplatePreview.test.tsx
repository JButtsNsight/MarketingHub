import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TemplatePreview } from "./TemplatePreview";
import type { Template } from "@/lib/templates/schema";

const textTemplate: Template = {
  id: "t1",
  name: "Plain Note",
  type: "text",
  category: "Announcement",
  tags: ["ops"],
  subject: null,
  body: "Line one\nLine two",
  storage_path: null,
  created_by: "amy@nsight.example",
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:00:00Z",
};

const emailTemplate: Template = {
  ...textTemplate,
  id: "t2",
  name: "Welcome",
  type: "email",
  subject: "Welcome aboard",
  body: '<h1>Hi</h1><script>alert(1)</script>',
};

describe("TemplatePreview", () => {
  test("text templates render the body in a monospace .surface panel", () => {
    const { container } = render(<TemplatePreview template={textTemplate} />);
    const panel = container.querySelector(".preview-text");
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass("mono");
    expect(panel?.className).toContain("surface");
    expect(panel?.textContent).toContain("Line one");
    expect(panel?.textContent).toContain("Line two");
    // no iframe for text templates
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("email templates show the subject and a sandboxed srcDoc iframe (no script exec)", () => {
    const { container } = render(<TemplatePreview template={emailTemplate} />);
    expect(screen.getByText(/welcome aboard/i)).toBeInTheDocument();

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    // srcDoc carries the raw HTML body...
    expect(frame?.getAttribute("srcdoc")).toBe(emailTemplate.body);
    // ...but the sandbox forbids script execution (no allow-scripts token).
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
  });

  test("email preview has a source toggle that swaps the iframe for raw HTML", async () => {
    const user = userEvent.setup();
    const { container } = render(<TemplatePreview template={emailTemplate} />);

    expect(container.querySelector("iframe")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /source/i }));

    // now the raw HTML source is shown and the iframe is gone
    expect(container.querySelector("iframe")).toBeNull();
    const source = container.querySelector(".preview-source");
    expect(source?.textContent).toContain("<script>alert(1)</script>");

    // toggling back restores the rendered preview
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(container.querySelector("iframe")).not.toBeNull();
  });
});
