"use client";

import { useEffect, useState } from "react";
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import { Surface } from "./Surface";

function SunIcon() {
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
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
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/**
 * The global theme control (§2.4 of the spec) — a single sun/moon icon
 * button that flips light ⇄ dark. The icon shows the mode a click switches
 * TO: a moon in light mode, a sun in dark mode.
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <div className="theme-toggle">
      <Surface as="div" className="seg" elevated={false}>
        <button
          type="button"
          className="seg-btn"
          aria-label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          onClick={() => {
            setTheme(next);
            setThemeState(next);
          }}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </Surface>
    </div>
  );
}

export default ThemeToggle;
