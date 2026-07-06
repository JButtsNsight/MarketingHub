import { describe, it, expect, beforeEach } from "vitest";
import {
  getTheme,
  getSkin,
  setTheme,
  setSkin,
  initTheme,
  THEME_KEY,
  SKIN_KEY,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.skin;
});

describe("theme", () => {
  it("setTheme writes data-theme on <html> and persists to localStorage", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("setSkin writes data-skin on <html> and persists to localStorage", () => {
    setSkin("flat");
    expect(document.documentElement.dataset.skin).toBe("flat");
    expect(localStorage.getItem(SKIN_KEY)).toBe("flat");
    expect(getSkin()).toBe("flat");
  });

  it("initTheme restores persisted values", () => {
    localStorage.setItem(THEME_KEY, "dark");
    localStorage.setItem(SKIN_KEY, "flat");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.skin).toBe("flat");
  });

  it("initTheme applies defaults (light + glass) when nothing is persisted", () => {
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.skin).toBe("glass");
  });

  it("ignores invalid persisted values and falls back to defaults", () => {
    localStorage.setItem(THEME_KEY, "chartreuse");
    localStorage.setItem(SKIN_KEY, "frosted");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.skin).toBe("glass");
  });
});
