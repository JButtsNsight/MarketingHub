import { describe, expect, test } from "vitest";
import { sendAtForEasternDate } from "./schedule";

describe("sendAtForEasternDate", () => {
  test("EST (winter): 11:30 ET on 2026-01-15 is 16:30Z", () => {
    expect(sendAtForEasternDate("2026-01-15").toISOString()).toBe(
      "2026-01-15T16:30:00.000Z",
    );
  });

  test("EDT (summer): 11:30 ET on 2026-07-15 is 15:30Z", () => {
    expect(sendAtForEasternDate("2026-07-15").toISOString()).toBe(
      "2026-07-15T15:30:00.000Z",
    );
  });

  test("spring-forward day 2026-03-08: 11:30 is already EDT → 15:30Z", () => {
    expect(sendAtForEasternDate("2026-03-08").toISOString()).toBe(
      "2026-03-08T15:30:00.000Z",
    );
  });

  test("fall-back day 2026-11-01: 11:30 is already EST → 16:30Z", () => {
    expect(sendAtForEasternDate("2026-11-01").toISOString()).toBe(
      "2026-11-01T16:30:00.000Z",
    );
  });

  test("days flanking the transitions use the outgoing offset", () => {
    // Day before spring-forward is still EST; day before fall-back still EDT.
    expect(sendAtForEasternDate("2026-03-07").toISOString()).toBe(
      "2026-03-07T16:30:00.000Z",
    );
    expect(sendAtForEasternDate("2026-10-31").toISOString()).toBe(
      "2026-10-31T15:30:00.000Z",
    );
  });

  test("throws on malformed input", () => {
    for (const bad of ["", "tomorrow", "2026-7-5", "07/15/2026", "2026-07-15T00:00:00Z"]) {
      expect(() => sendAtForEasternDate(bad), JSON.stringify(bad)).toThrow(
        /YYYY-MM-DD/,
      );
    }
  });

  test("throws on impossible calendar dates", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-15", "2026-04-31"]) {
      expect(() => sendAtForEasternDate(bad), JSON.stringify(bad)).toThrow(
        /calendar/,
      );
    }
  });
});
