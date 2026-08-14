"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/** Focusables the trap cycles through; disabled controls are skipped. */
const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * Small form modal on the alert-dialog card idiom (ui/AlertDialog.tsx) for
 * flows a yes/no confirm can't carry. Initial focus lands on the FIRST
 * focusable (a field or Cancel — never the primary action, so a reflexive
 * Enter can't submit), Tab is trapped inside the card, and Escape or a
 * backdrop click closes without acting.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="alert-backdrop"
      onClick={onClose}
      data-testid="modal-backdrop"
    >
      <div
        ref={cardRef}
        className="surface alert-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <h2 id={titleId} className="alert-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export default Modal;
