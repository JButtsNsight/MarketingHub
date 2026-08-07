// @vitest-environment node
import { describe, expect, test } from "vitest";

import {
  assertSafeInteger,
  assertValidIdentifier,
  clampLimit,
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "./identifiers";

describe("isValidIdentifier", () => {
  test("accepts unquoted-identifier shapes", () => {
    expect(isValidIdentifier("foo")).toBe(true);
    expect(isValidIdentifier("_x1")).toBe(true);
    expect(isValidIdentifier("marketinghub")).toBe(true);
    expect(isValidIdentifier("a".repeat(63))).toBe(true);
  });

  test("rejects everything that could break out of an identifier", () => {
    expect(isValidIdentifier("")).toBe(false);
    expect(isValidIdentifier("1foo")).toBe(false);
    expect(isValidIdentifier("a-b")).toBe(false);
    expect(isValidIdentifier("a b")).toBe(false);
    expect(isValidIdentifier('a"b')).toBe(false);
    expect(isValidIdentifier("a;b")).toBe(false);
    expect(isValidIdentifier("public.tbl")).toBe(false);
    expect(isValidIdentifier("a".repeat(64))).toBe(false);
    expect(isValidIdentifier(42)).toBe(false);
    expect(isValidIdentifier(null)).toBe(false);
  });
});

describe("quoteIdent / quoteQualified", () => {
  test("wraps a valid identifier in double quotes", () => {
    expect(quoteIdent("foo")).toBe('"foo"');
    expect(quoteQualified("public", "tbl")).toBe('"public"."tbl"');
  });

  test("throws on an unsafe identifier rather than emit it", () => {
    expect(() => quoteIdent("x; drop table users")).toThrow(/invalid identifier/);
    expect(() => quoteIdent('a"b')).toThrow(/invalid identifier/);
    expect(() => assertValidIdentifier("1bad", "schema")).toThrow(/invalid schema/);
  });
});

describe("quoteLiteral", () => {
  test("single-quotes and doubles embedded quotes", () => {
    expect(quoteLiteral("hello")).toBe("'hello'");
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
    expect(quoteLiteral("'; drop table x; --")).toBe("'''; drop table x; --'");
  });

  test("emits an E'' string when a backslash is present", () => {
    expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
  });

  test("null becomes the SQL keyword; non-strings are rejected", () => {
    expect(quoteLiteral(null)).toBe("NULL");
    expect(() => quoteLiteral(42 as unknown as string)).toThrow(/expects a string/);
  });
});

describe("assertSafeInteger / clampLimit", () => {
  test("assertSafeInteger only passes real integers", () => {
    expect(assertSafeInteger(7)).toBe(7);
    expect(() => assertSafeInteger(3.5)).toThrow(/invalid integer/);
    expect(() => assertSafeInteger("7" as unknown as number)).toThrow(/invalid integer/);
    expect(() => assertSafeInteger(Number.NaN)).toThrow(/invalid integer/);
  });

  test("clampLimit defaults, floors, and caps", () => {
    expect(clampLimit(undefined, 50, 500)).toBe(50);
    expect(clampLimit(25, 50, 500)).toBe(25);
    expect(clampLimit(0, 50, 500)).toBe(1);
    expect(clampLimit(9999, 50, 500)).toBe(500);
    expect(clampLimit(12.9, 50, 500)).toBe(12);
  });
});
