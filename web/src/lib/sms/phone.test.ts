import { describe, expect, test } from "vitest";
import { normalizeUsPhone } from "./phone";

describe("normalizeUsPhone", () => {
  test("normalizes a bare 10-digit number", () => {
    expect(normalizeUsPhone("2125551234")).toBe("+12125551234");
  });

  test("normalizes common US formatting", () => {
    expect(normalizeUsPhone("(212) 555-1234")).toBe("+12125551234");
    expect(normalizeUsPhone("212-555-1234")).toBe("+12125551234");
    expect(normalizeUsPhone("212.555.1234")).toBe("+12125551234");
    expect(normalizeUsPhone(" 212 555 1234 ")).toBe("+12125551234");
  });

  test("strips a leading 1 country code", () => {
    expect(normalizeUsPhone("12125551234")).toBe("+12125551234");
    expect(normalizeUsPhone("1-212-555-1234")).toBe("+12125551234");
  });

  test("accepts +1 E.164 input unchanged", () => {
    expect(normalizeUsPhone("+12125551234")).toBe("+12125551234");
    expect(normalizeUsPhone("+1 (212) 555-1234")).toBe("+12125551234");
  });

  test("returns null for wrong digit counts", () => {
    expect(normalizeUsPhone("555-1234")).toBeNull();
    expect(normalizeUsPhone("21255512345")).toBeNull();
    expect(normalizeUsPhone("121255512")).toBeNull();
    expect(normalizeUsPhone("")).toBeNull();
    expect(normalizeUsPhone("   ")).toBeNull();
  });

  test("rejects bad area codes (must start 2-9)", () => {
    expect(normalizeUsPhone("0125551234")).toBeNull();
    expect(normalizeUsPhone("1125551234")).toBeNull();
    expect(normalizeUsPhone("+10125551234")).toBeNull();
  });

  test("rejects letters left over after stripping formatting", () => {
    expect(normalizeUsPhone("212-555-CALL")).toBeNull();
    expect(normalizeUsPhone("n/a")).toBeNull();
  });

  test("accepts a US country hint (any case) and missing hints", () => {
    expect(normalizeUsPhone("2125551234", "US")).toBe("+12125551234");
    expect(normalizeUsPhone("2125551234", "us")).toBe("+12125551234");
    expect(normalizeUsPhone("2125551234", undefined)).toBe("+12125551234");
    expect(normalizeUsPhone("2125551234", "")).toBe("+12125551234");
  });

  test("rejects non-US country hints", () => {
    expect(normalizeUsPhone("2125551234", "CA")).toBeNull();
    expect(normalizeUsPhone("+442071234567", "GB")).toBeNull();
  });
});
