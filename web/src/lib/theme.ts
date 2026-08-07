/**
 * Theme control for the NSight design language.
 * One axis lives on <html>: data-theme (light|dark|supabase). Surfaces are
 * always flat (the glass skin is gone). The choice persists to localStorage so
 * it sticks. `supabase` is a novelty theme that reproduces Supabase Studio's
 * dark chrome + green — opt-in only; light/dark carry the NSight language.
 */

export type Theme = "light" | "dark" | "supabase";

export const THEME_KEY = "mh-theme";
/** Key of the retired glass/flat skin axis — initTheme clears it from returning browsers. */
export const LEGACY_SKIN_KEY = "mh-skin";

export const DEFAULT_THEME: Theme = "light";

const THEMES: readonly Theme[] = ["light", "dark", "supabase"];

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** Current theme from <html>, defaulting when unset/invalid. */
export function getTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const v = document.documentElement.dataset.theme;
  return isTheme(v) ? v : DEFAULT_THEME;
}

/** Set the theme on <html> and persist it. */
export function setTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable (private mode, SSR) — non-fatal */
  }
}

/** Restore the persisted theme (or apply the default) to <html>. */
export function initTheme(): void {
  let storedTheme: string | null = null;
  try {
    storedTheme = localStorage.getItem(THEME_KEY);
    localStorage.removeItem(LEGACY_SKIN_KEY);
  } catch {
    /* storage unavailable — fall back to the default */
  }
  setTheme(isTheme(storedTheme) ? storedTheme : DEFAULT_THEME);
}
