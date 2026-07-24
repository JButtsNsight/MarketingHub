import { describe, expect, test } from "vitest";
import { firstNameOf, renderSms, unsupportedMergeFields } from "./render";

describe("firstNameOf", () => {
  test("takes the first word of a full name", () => {
    expect(firstNameOf("Jane Doe")).toBe("Jane");
    expect(firstNameOf("Mary Jane Smith")).toBe("Mary");
  });

  test("trims whitespace and handles single-word names", () => {
    expect(firstNameOf("  Jane  ")).toBe("Jane");
    expect(firstNameOf("Cher")).toBe("Cher");
  });

  test("strips a trailing comma (\"Smith, John\" style cells)", () => {
    expect(firstNameOf("Smith, John")).toBe("Smith");
  });

  test("returns an empty string for blank input", () => {
    expect(firstNameOf("")).toBe("");
    expect(firstNameOf("   ")).toBe("");
  });
});

describe("renderSms", () => {
  test("replaces {{name}} and {{firstName}}", () => {
    expect(
      renderSms("Hi {{firstName}}! Confirming for {{name}}.", {
        name: "Jane Doe",
        firstName: "Jane",
      }),
    ).toBe("Hi Jane! Confirming for Jane Doe.");
  });

  test("is case and space tolerant inside the braces", () => {
    expect(renderSms("Hi {{ Name }}", { name: "Jane Doe" })).toBe("Hi Jane Doe");
    expect(renderSms("Hi {{FIRSTNAME}}", { name: "Jane Doe" })).toBe("Hi Jane");
    expect(renderSms("Hi {{ First Name }}", { name: "Jane Doe" })).toBe("Hi Jane");
  });

  test("derives firstName from name when not provided", () => {
    expect(renderSms("Hi {{firstName}}", { name: "Jane Doe" })).toBe("Hi Jane");
  });

  test("replaces every occurrence", () => {
    expect(renderSms("{{name}} / {{name}}", { name: "Jane Doe" })).toBe(
      "Jane Doe / Jane Doe",
    );
  });

  test("leaves unsupported merge fields untouched", () => {
    expect(renderSms("Hi {{name}}, ref {{caseId}}", { name: "Jane Doe" })).toBe(
      "Hi Jane Doe, ref {{caseId}}",
    );
  });

  test("passes through bodies with no merge fields", () => {
    expect(renderSms("Reminder: visit tomorrow.", { name: "Jane Doe" })).toBe(
      "Reminder: visit tomorrow.",
    );
  });
});

describe("unsupportedMergeFields", () => {
  test("returns [] when only supported fields are used", () => {
    expect(
      unsupportedMergeFields("Hi {{firstName}}, this is for {{ Name }}."),
    ).toEqual([]);
  });

  test("returns [] for bodies with no merge fields", () => {
    expect(unsupportedMergeFields("No fields here.")).toEqual([]);
  });

  test("lists unsupported fields", () => {
    expect(
      unsupportedMergeFields("Hi {{firstName}}, ref {{caseId}} on {{apptDate}}"),
    ).toEqual(["caseId", "apptDate"]);
  });

  test("de-duplicates case/space variants of the same field", () => {
    expect(
      unsupportedMergeFields("{{lastName}} {{ last name }} {{LASTNAME}}"),
    ).toEqual(["lastName"]);
  });
});
