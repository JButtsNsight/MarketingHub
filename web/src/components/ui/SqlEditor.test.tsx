import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SqlEditor } from "./SqlEditor";

/**
 * CodeMirror mounts a real EditorView into jsdom — enough for contract tests
 * (document seeding, external value sync, host attributes). Keyboard-driven
 * behavior (Mod-Enter) is covered indirectly: the binding is registered at
 * highest precedence and exercised in e2e/manual parity checks, since jsdom
 * has no real key dispatch into CodeMirror's content DOM.
 */

describe("SqlEditor", () => {
  test("mounts CodeMirror with the seeded document", () => {
    render(
      <SqlEditor
        value="select * from marketinghub.templates"
        onChange={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    const host = screen.getByRole("textbox", { name: "SQL editor" });
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(host.textContent).toContain("select * from marketinghub.templates");
  });

  test("external value changes replace the document (snippet loading)", () => {
    const { rerender } = render(
      <SqlEditor value="select 1" onChange={vi.fn()} onRun={vi.fn()} />,
    );
    rerender(
      <SqlEditor
        value="select count(*) from marketinghub.sms_campaigns"
        onChange={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    const host = screen.getByRole("textbox", { name: "SQL editor" });
    expect(host.textContent).toContain(
      "select count(*) from marketinghub.sms_campaigns",
    );
    expect(host.textContent).not.toContain("select 1");
  });

  test("custom aria label lands on the host", () => {
    render(
      <SqlEditor
        value=""
        onChange={vi.fn()}
        onRun={vi.fn()}
        ariaLabel="Snippet editor"
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Snippet editor" }),
    ).toBeInTheDocument();
  });
});
