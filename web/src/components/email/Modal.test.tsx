import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Modal } from "./Modal";

afterEach(cleanup);

function renderModal(onClose = vi.fn()) {
  render(
    <Modal title="Test dialog" onClose={onClose}>
      <input aria-label="Field" />
      <button type="button">Cancel</button>
      <button type="button" className="btn-primary">
        Go
      </button>
    </Modal>,
  );
  return onClose;
}

describe("Modal", () => {
  test("labels itself and focuses the first field — never the primary action", () => {
    renderModal();
    const dlg = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Field")).toHaveFocus();
  });

  test("traps Tab inside the card in both directions", async () => {
    const user = userEvent.setup();
    renderModal();

    // Forward: last focusable wraps to the first.
    screen.getByRole("button", { name: "Go" }).focus();
    await user.tab();
    expect(screen.getByLabelText("Field")).toHaveFocus();

    // Backward: first focusable wraps to the last.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Go" })).toHaveFocus();
  });

  test("Escape and a backdrop click both close", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
