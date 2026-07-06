/**
 * Theme + skin control for the NSight design language.
 * Two independent axes live on <html>: data-theme (light|dark) and
 * data-skin (glass|flat). Both persist to localStorage so the choice sticks.
 */

export type Theme = "light" | "dark";
export type Skin = "glass" | "flat";

export const THEME_KEY = "mh-theme";
export const SKIN_KEY = "mh-skin";

export const DEFAULT_THEME: Theme = "light";
export const DEFAULT_SKIN: Skin = "glass";

const THEMES: readonly Theme[] = ["light", "dark"];
const SKINS: readonly Skin[] = ["glass", "flat"];

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}
function isSkin(v: unknown): v is Skin {
  return typeof v === "string" && (SKINS as readonly string[]).includes(v);
}

/** Current theme from <html>, defaulting when unset/invalid. */
export function getTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const v = document.documentElement.dataset.theme;
  return isTheme(v) ? v : DEFAULT_THEME;
}

/** Current skin from <html>, defaulting when unset/invalid. */
export function getSkin(): Skin {
  if (typeof document === "undefined") return DEFAULT_SKIN;
  const v = document.documentElement.dataset.skin;
  return isSkin(v) ? v : DEFAULT_SKIN;
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

/** Set the skin on <html> and persist it. */
export function setSkin(skin: Skin): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.skin = skin;
  }
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Restore persisted theme + skin (or apply defaults) to <html>. */
export function initTheme(): void {
  let storedTheme: string | null = null;
  let storedSkin: string | null = null;
  try {
    storedTheme = localStorage.getItem(THEME_KEY);
    storedSkin = localStorage.getItem(SKIN_KEY);
  } catch {
    /* storage unavailable — fall back to defaults */
  }
  setTheme(isTheme(storedTheme) ? storedTheme : DEFAULT_THEME);
  setSkin(isSkin(storedSkin) ? storedSkin : DEFAULT_SKIN);
}
