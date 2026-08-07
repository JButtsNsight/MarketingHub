import { describe, it, expect, beforeEach } from "vitest";
import {
  getTheme,
  setTheme,
  initTheme,
  THEME_KEY,
  LEGACY_SKIN_KEY,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme", () => {
  it("setTheme writes data-theme on <html> and persists to localStorage", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("initTheme restores the persisted theme", () => {
    localStorage.setItem(THEME_KEY, "dark");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("initTheme applies the default (light) when nothing is persisted", () => {
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores an invalid persisted value and falls back to the default", () => {
    localStorage.setItem(THEME_KEY, "chartreuse");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("accepts the supabase novelty theme as a valid value", () => {
    setTheme("supabase");
    expect(document.documentElement.dataset.theme).toBe("supabase");
    expect(getTheme()).toBe("supabase");
    localStorage.setItem(THEME_KEY, "supabase");
    delete document.documentElement.dataset.theme;
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("supabase");
  });

  it("initTheme clears the retired glass/flat skin key from returning browsers", () => {
    localStorage.setItem(LEGACY_SKIN_KEY, "glass");
    initTheme();
    expect(localStorage.getItem(LEGACY_SKIN_KEY)).toBeNull();
  });
});
