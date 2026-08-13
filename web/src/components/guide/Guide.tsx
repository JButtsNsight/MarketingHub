"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { guideFor } from "@/lib/guides";
import { useGuided } from "./useGuided";

const HOVER_DELAY_MS = 150;
const GAP = 6;
const VIEWPORT_PAD = 8;

/**
 * Guided-mode annotation: wrap a control in `<Guide>` with a registry id
 * (`domain.surface.control` — see lib/guides/).
 *
 * With guided mode OFF (or before hydration) the wrapper is `display: contents`
 * — no box, no layout impact, the control renders exactly as before. With it ON,
 * hover or keyboard focus (bubbled from the child — the wrapper itself has no
 * box to focus) raises a fixed-position popover with the registry copy;
 * Escape, blur, mouseleave, or any scroll dismisses it.
 *
 * Unknown ids render children untouched and log loudly outside production —
 * the registry integrity test also fails on them, so they can't ship silently.
 */
export function Guide({ id, children }: { id: string; children: ReactNode }) {
  const guided = useGuided();
  const entry = guideFor(id);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipId = useId();

  // Mode flipped off (or unmounted) while a popover was up.
  useEffect(() => {
    if (!guided) setOpen(false);
    return () => window.clearTimeout(timer.current);
  }, [guided]);

  // Place the popover once it has rendered: below the anchor, flipped above
  // when there's no room, clamped to the viewport horizontally.
  useLayoutEffect(() => {
    if (!open) return;
    setPos(null);
    const anchor = wrapRef.current?.firstElementChild as HTMLElement | null;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    let top = a.bottom + GAP;
    if (top + p.height > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, a.top - GAP - p.height);
    }
    const left = Math.min(
      Math.max(VIEWPORT_PAD, a.left),
      Math.max(VIEWPORT_PAD, window.innerWidth - VIEWPORT_PAD - p.width),
    );
    setPos({ top, left });
  }, [open]);

  // While open: Escape or any scroll dismisses (the popover is fixed and
  // would otherwise drift away from its anchor).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  if (!entry) {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[guide] unknown guide id "${id}"`);
    }
    return <>{children}</>;
  }

  const arm = () => {
    if (!guided) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  };
  const disarm = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      ref={wrapRef}
      className="guide-wrap"
      data-guide-id={id}
      onMouseEnter={arm}
      onMouseLeave={disarm}
      onFocus={() => {
        if (guided) setOpen(true);
      }}
      onBlur={disarm}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="tooltip"
            id={tipId}
            className="guide-pop"
            style={
              pos
                ? { top: pos.top, left: pos.left }
                : { top: 0, left: 0, visibility: "hidden" }
            }
          >
            <p className="guide-pop-title">{entry.title}</p>
            <p className="guide-pop-body">{entry.body}</p>
          </div>,
          document.body,
        )}
    </span>
  );
}

export default Guide;
