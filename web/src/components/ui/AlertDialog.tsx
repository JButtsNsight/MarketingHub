"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A real modal alert — a backdrop + centered card that INTERRUPTS the action
 * and demands an explicit choice, for destructive/risky operations that a
 * flat inline note wouldn't stop. Accent is `warn` (orange), never the
 * failure red the design language reserves for actual failures.
 *
 * Use through `useConfirm()`: `const { confirm, dialog } = useConfirm()`,
 * render `{dialog}`, and `await confirm({ title, message })` at the action —
 * it resolves true (proceed) or false (cancelled / Escape / backdrop).
 */

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "warn" | "default";
}

export function AlertDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "warn",
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Focus the SAFE action (Cancel) so a reflexive Enter/Space doesn't confirm
  // a destructive op; Escape and a backdrop click also cancel.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="alert-backdrop"
      onClick={onCancel}
      data-testid="alert-backdrop"
    >
      <div
        className={`surface alert-dialog alert-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-title"
        aria-describedby="alert-msg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="alert-title" className="alert-title">
          {title}
        </h2>
        <div id="alert-msg" className="alert-msg">
          {message}
        </div>
        <div className="alert-actions">
          <button
            ref={cancelRef}
            type="button"
            className="type-chip"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn-primary alert-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise-based confirmation. `confirm(opts)` opens the dialog and resolves
 * when the user chooses; render the returned `dialog` node once in the tree.
 */
export function useConfirm() {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const settle = (value: boolean) => {
    setPending((p) => {
      p?.resolve(value);
      return null;
    });
  };

  const dialog = pending ? (
    <AlertDialog
      {...pending}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, dialog };
}

export default AlertDialog;
