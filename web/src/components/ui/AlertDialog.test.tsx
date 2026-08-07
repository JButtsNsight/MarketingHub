import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import { AlertDialog, useConfirm } from "./AlertDialog";

afterEach(() => vi.restoreAllMocks());

describe("AlertDialog", () => {
  test("renders as an alertdialog with title + message and focuses Cancel (the safe action)", () => {
    render(
      <AlertDialog
        title="Edit a protected table?"
        message="This can cause a double-send."
        confirmLabel="Edit anyway"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Edit a protected table?")).toBeInTheDocument();
    expect(screen.getByText("This can cause a double-send.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  test("Confirm and Cancel fire their callbacks", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <AlertDialog
        title="t"
        message="m"
        confirmLabel="Edit anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Escape and backdrop click cancel", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <AlertDialog title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("alert-backdrop"));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("useConfirm", () => {
  // A tiny harness that calls confirm() on mount and reports the resolution.
  function Harness({ onResolved }: { onResolved: (v: boolean) => void }) {
    const { confirm, dialog } = useConfirm();
    useEffect(() => {
      void confirm({ title: "Proceed?", message: "risky" }).then(onResolved);
    }, [confirm, onResolved]);
    return <>{dialog}</>;
  }

  test("resolves true on confirm and dismisses the dialog", async () => {
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(<Harness onResolved={onResolved} />);

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("resolves false on cancel", async () => {
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(<Harness onResolved={onResolved} />);

    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
