"use client";

import { useEffect, useState } from "react";
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import { Surface } from "./Surface";

type Segment<T extends string> = { value: T; label: string };

const THEME_SEGMENTS: Segment<Theme>[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "supabase", label: "Supabase" },
];

function Segmented<T extends string>({
  ariaLabel,
  segments,
  value,
  onSelect,
}: {
  ariaLabel: string;
  segments: Segment<T>[];
  value: T;
  onSelect: (v: T) => void;
}) {
  return (
    <Surface
      as="div"
      role="group"
      aria-label={ariaLabel}
      className="seg"
      elevated={false}
    >
      {segments.map((s) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            className={active ? "seg-btn on" : "seg-btn"}
            aria-pressed={active}
            onClick={() => onSelect(s.value)}
          >
            {s.label}
          </button>
        );
      })}
    </Surface>
  );
}

/**
 * The global Light/Dark control. This sets the app-wide theme (§2.4 of the
 * spec) — every surface-bearing element honors the choice.
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  return (
    <div className="theme-toggle">
      <Segmented
        ariaLabel="Theme"
        segments={THEME_SEGMENTS}
        value={theme}
        onSelect={(v) => {
          setTheme(v);
          setThemeState(v);
        }}
      />
    </div>
  );
}

export default ThemeToggle;
