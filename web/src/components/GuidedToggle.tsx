"use client";

import { setGuided } from "@/lib/guided";
import { useGuided } from "./guide/useGuided";
import { Surface } from "./Surface";

function CapIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 10 12 5 2 10l10 5 10-5z" />
      <path d="M6 12.5V17c0 1.66 2.69 3 6 3s6-1.34 6-3v-4.5" />
      <path d="M22 10v5" />
    </svg>
  );
}

/**
 * The guided-mode control — a graduation-cap icon button beside the theme
 * toggle. While on (aria-pressed), hovering any annotated control raises a
 * concise plain-English explanation (see components/guide/Guide.tsx).
 */
export function GuidedToggle() {
  const guided = useGuided();

  return (
    <div className="guided-toggle">
      <Surface as="div" className="seg" elevated={false}>
        <button
          type="button"
          className={guided ? "seg-btn on" : "seg-btn"}
          aria-pressed={guided}
          aria-label={`Turn guided mode ${guided ? "off" : "on"}`}
          title={`Turn guided mode ${guided ? "off" : "on"}`}
          onClick={() => setGuided(!guided)}
        >
          <CapIcon />
        </button>
      </Surface>
    </div>
  );
}

export default GuidedToggle;
