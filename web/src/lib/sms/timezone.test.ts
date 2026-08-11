import { describe, expect, test } from "vitest";
import { normalizeRecipientZone } from "./timezone";

describe("normalizeRecipientZone", () => {
  test("maps every send-zone IANA id to itself", () => {
    for (const id of [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Pacific/Honolulu",
    ]) {
      expect(normalizeRecipientZone(id)).toBe(id);
    }
  });

  test("maps US abbreviations to their IANA ids", () => {
    expect(normalizeRecipientZone("ET")).toBe("America/New_York");
    expect(normalizeRecipientZone("CT")).toBe("America/Chicago");
    expect(normalizeRecipientZone("MT")).toBe("America/Denver");
    expect(normalizeRecipientZone("PT")).toBe("America/Los_Angeles");
    expect(normalizeRecipientZone("HT")).toBe("Pacific/Honolulu");
  });

  test("tolerates case and surrounding whitespace", () => {
    expect(normalizeRecipientZone("america/new_york")).toBe("America/New_York");
    expect(normalizeRecipientZone("AMERICA/CHICAGO")).toBe("America/Chicago");
    expect(normalizeRecipientZone("  Pacific/Honolulu  ")).toBe("Pacific/Honolulu");
    expect(normalizeRecipientZone("et")).toBe("America/New_York");
    expect(normalizeRecipientZone(" pt ")).toBe("America/Los_Angeles");
    expect(normalizeRecipientZone("\tCt\n")).toBe("America/Chicago");
  });

  test("returns null for unknown zones (callers fall back to the campaign zone)", () => {
    for (const raw of [
      "America/Anchorage", // real IANA id, not a send zone
      "UTC",
      "EST", // fixed-offset alias, deliberately unsupported
      "Eastern", // label, not an abbreviation
      "AK",
      "not a zone",
    ]) {
      expect(normalizeRecipientZone(raw), raw).toBeNull();
    }
  });

  test("returns null for empty/blank/missing input", () => {
    expect(normalizeRecipientZone("")).toBeNull();
    expect(normalizeRecipientZone("   ")).toBeNull();
    expect(normalizeRecipientZone(null)).toBeNull();
    expect(normalizeRecipientZone(undefined)).toBeNull();
  });
});
