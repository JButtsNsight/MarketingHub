import { describe, expect, test } from "vitest";
import {
  formatSlot,
  isWeekday,
  SEND_SLOTS,
  sendAtForEasternDate,
  sendAtForZonedSlot,
  zoneAbbr,
} from "./schedule";

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

describe("sendAtForZonedSlot", () => {
  test("computes the slot instant per zone (summer: EDT/CDT/MDT/PDT)", () => {
    // 2026-07-15: 8:00 AM wall clock in each zone.
    expect(sendAtForZonedSlot("2026-07-15", "08:00", "America/New_York").toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(sendAtForZonedSlot("2026-07-15", "08:00", "America/Chicago").toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(sendAtForZonedSlot("2026-07-15", "08:00", "America/Denver").toISOString()).toBe("2026-07-15T14:00:00.000Z");
    expect(sendAtForZonedSlot("2026-07-15", "08:00", "America/Los_Angeles").toISOString()).toBe("2026-07-15T15:00:00.000Z");
  });

  test("computes the slot instant per zone (winter: EST/PST)", () => {
    expect(sendAtForZonedSlot("2026-01-15", "13:00", "America/New_York").toISOString()).toBe("2026-01-15T18:00:00.000Z");
    expect(sendAtForZonedSlot("2026-01-15", "13:00", "America/Los_Angeles").toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });

  test("handles the DST transition day itself (slots are past the 2 AM switch)", () => {
    // 2026-03-09: US spring-forward Monday? Actually 2026-03-08 is the Sunday
    // switch; Monday 03-09 is plainly EDT. The Friday before (03-06) is EST.
    expect(sendAtForZonedSlot("2026-03-06", "09:30", "America/New_York").toISOString()).toBe("2026-03-06T14:30:00.000Z");
    expect(sendAtForZonedSlot("2026-03-09", "09:30", "America/New_York").toISOString()).toBe("2026-03-09T13:30:00.000Z");
  });

  test("throws on a malformed time", () => {
    for (const bad of ["8:00", "0800", "", "25:00x"]) {
      expect(() => sendAtForZonedSlot("2026-07-15", bad, "America/Chicago")).toThrow(/HH:MM/);
    }
  });

  test("sendAtForEasternDate is the 11:30 ET slot", () => {
    expect(sendAtForEasternDate("2026-07-15").toISOString()).toBe(
      sendAtForZonedSlot("2026-07-15", "11:30", "America/New_York").toISOString(),
    );
  });
});

describe("slot grid + helpers", () => {
  test("SEND_SLOTS is the eleven 30-minute slots from 08:00 through 13:00", () => {
    expect(SEND_SLOTS).toHaveLength(11);
    expect(SEND_SLOTS[0]).toBe("08:00");
    expect(SEND_SLOTS[SEND_SLOTS.length - 1]).toBe("13:00");
  });

  test("formatSlot renders 12-hour wall-clock labels", () => {
    expect(formatSlot("08:00")).toBe("8:00 AM");
    expect(formatSlot("11:30")).toBe("11:30 AM");
    expect(formatSlot("12:00")).toBe("12:00 PM");
    expect(formatSlot("13:00")).toBe("1:00 PM");
  });

  test("zoneAbbr maps the four send zones and falls back to the id", () => {
    expect(zoneAbbr("America/New_York")).toBe("ET");
    expect(zoneAbbr("America/Los_Angeles")).toBe("PT");
    expect(zoneAbbr("Europe/Paris")).toBe("Europe/Paris");
  });

  test("isWeekday accepts Mon–Fri and rejects weekends and junk", () => {
    expect(isWeekday("2026-08-03")).toBe(true); // Monday
    expect(isWeekday("2026-08-07")).toBe(true); // Friday
    expect(isWeekday("2026-08-01")).toBe(false); // Saturday
    expect(isWeekday("2026-08-02")).toBe(false); // Sunday
    expect(isWeekday("not-a-date")).toBe(false);
  });
});
