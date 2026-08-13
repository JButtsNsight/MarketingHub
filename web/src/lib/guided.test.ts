import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GUIDED_KEY,
  getGuided,
  setGuided,
  initGuided,
  subscribeGuided,
} from "./guided";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.guided;
});

describe("guided axis", () => {
  it("defaults off: no attribute, getGuided false", () => {
    expect(getGuided()).toBe(false);
    expect(document.documentElement.dataset.guided).toBeUndefined();
  });

  it("setGuided(true) sets data-guided='on' and persists", () => {
    setGuided(true);
    expect(document.documentElement.dataset.guided).toBe("on");
    expect(getGuided()).toBe(true);
    expect(localStorage.getItem(GUIDED_KEY)).toBe("on");
  });

  it("setGuided(false) removes the attribute entirely (not ='off')", () => {
    setGuided(true);
    setGuided(false);
    expect(document.documentElement.dataset.guided).toBeUndefined();
    expect(localStorage.getItem(GUIDED_KEY)).toBe("off");
  });

  it("initGuided restores 'on'; anything else (junk, absent) is off", () => {
    localStorage.setItem(GUIDED_KEY, "on");
    initGuided();
    expect(getGuided()).toBe(true);

    localStorage.setItem(GUIDED_KEY, "banana");
    initGuided();
    expect(getGuided()).toBe(false);

    localStorage.removeItem(GUIDED_KEY);
    initGuided();
    expect(getGuided()).toBe(false);
  });

  it("subscribeGuided fires on every flip and unsubscribes cleanly", () => {
    const cb = vi.fn();
    const off = subscribeGuided(cb);
    setGuided(true);
    setGuided(false);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    setGuided(true);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
