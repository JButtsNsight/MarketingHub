/**
 * Guided-mode control. Mirrors the theme axis (lib/theme.ts): one attribute on
 * <html> — data-guided="on" (absent when off) — persisted to localStorage so it
 * sticks. Guided mode raises plain-English hover popovers over the app's
 * controls (live documentation for users new to Supabase); OFF renders the UI
 * untouched. Server pages can't thread React context to the client islands, so
 * flips broadcast a DOM event and useGuided() subscribes to it.
 */

export const GUIDED_KEY = "mh-guided";
export const GUIDED_EVENT = "mh-guided-change";

export const DEFAULT_GUIDED = false;

/** Current guided state from <html>; false on the server. */
export function getGuided(): boolean {
  if (typeof document === "undefined") return DEFAULT_GUIDED;
  return document.documentElement.dataset.guided === "on";
}

/** Set guided mode on <html>, persist it, and notify subscribers. */
export function setGuided(on: boolean): void {
  if (typeof document !== "undefined") {
    if (on) {
      document.documentElement.dataset.guided = "on";
    } else {
      delete document.documentElement.dataset.guided;
    }
  }
  try {
    localStorage.setItem(GUIDED_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable (private mode, SSR) — non-fatal */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GUIDED_EVENT));
  }
}

/** Restore the persisted guided state (default off) to <html>. */
export function initGuided(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(GUIDED_KEY);
  } catch {
    /* storage unavailable — default off */
  }
  setGuided(stored === "on");
}

/** Subscribe to guided-mode flips; returns the unsubscribe. */
export function subscribeGuided(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GUIDED_EVENT, cb);
  return () => window.removeEventListener(GUIDED_EVENT, cb);
}
