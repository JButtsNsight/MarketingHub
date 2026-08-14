import { describe, expect, test } from "vitest";
import { parseContactSheet, SheetParseError } from "./csv";

describe("parseContactSheet", () => {
  test("parses a simple comma sheet with name + phone headers", () => {
    const sheet = parseContactSheet(
      "name,phone\nJane Doe,(555) 923-4567\nJohn Roe,555.923.4568\n",
    );
    expect(sheet.counts).toEqual({ ok: 2, invalid: 0, duplicate: 0, total: 2 });
    expect(sheet.phoneHeader).toBe("phone");
    expect(sheet.nameHeader).toBe("name");
    expect(sheet.contacts[0]).toEqual({
      name: "Jane Doe",
      firstName: "Jane",
      phoneE164: "+15559234567",
      rawPhone: "(555) 923-4567",
      reason: "ok",
    });
  });

  test("matches phone-header variants case/punctuation-insensitively", () => {
    for (const header of ["Phone", "PHONE NUMBER", "Mobile", "Cell Phone", "phone (mobile)"]) {
      const sheet = parseContactSheet(`name,${header}\nJane,5559234567\n`);
      expect(sheet.counts.ok, `header ${header}`).toBe(1);
    }
  });

  test("joins First/Last name columns and prefers the first-name cell for {{firstName}}", () => {
    const sheet = parseContactSheet(
      "First Name,Last Name,Cell\nJane,Doe,5559234567\n",
    );
    expect(sheet.contacts[0].name).toBe("Jane Doe");
    expect(sheet.contacts[0].firstName).toBe("Jane");
  });

  test("handles quoted fields with embedded delimiters, quotes, and newlines", () => {
    const sheet = parseContactSheet(
      'name,phone,notes\n"Doe, Jane",5559234567,"She said ""hi""\nsecond line"\n',
    );
    expect(sheet.counts.ok).toBe(1);
    expect(sheet.contacts[0].name).toBe("Doe, Jane");
  });

  test("sniffs tab-delimited sheets", () => {
    const sheet = parseContactSheet("name\tphone\nJane Doe\t5559234567\n");
    expect(sheet.counts.ok).toBe(1);
  });

  test("handles CRLF line endings and a UTF-8 BOM", () => {
    const sheet = parseContactSheet(
      "﻿name,phone\r\nJane,5559234567\r\n",
    );
    expect(sheet.counts.ok).toBe(1);
    expect(sheet.phoneHeader).toBe("phone");
  });

  test("classifies unusable phones as invalid, keeping the raw value", () => {
    const sheet = parseContactSheet(
      "name,phone\nJane,5559234567\nBad,12345\nBlank,\n",
    );
    expect(sheet.counts).toEqual({ ok: 1, invalid: 2, duplicate: 0, total: 3 });
    expect(sheet.contacts[1]).toMatchObject({
      phoneE164: null,
      rawPhone: "12345",
      reason: "invalid",
    });
  });

  test("classifies repeated phones as duplicate with a NULL phone (first wins)", () => {
    const sheet = parseContactSheet(
      "name,phone\nJane,5559234567\nJane Again,(555) 923-4567\n",
    );
    expect(sheet.counts).toEqual({ ok: 1, invalid: 0, duplicate: 1, total: 2 });
    // The dupe must NOT carry the phone: contact_list_members has
    // unique (list_id, phone_e164) and nulls are distinct.
    expect(sheet.contacts[1]).toMatchObject({
      phoneE164: null,
      reason: "duplicate",
    });
  });

  test("a missing name column yields blank names, not a parse error", () => {
    const sheet = parseContactSheet("phone\n5559234567\n");
    expect(sheet.counts.ok).toBe(1);
    expect(sheet.contacts[0].name).toBe("");
    expect(sheet.nameHeader).toBeNull();
  });

  test("skips fully blank rows (trailing newline artifacts)", () => {
    const sheet = parseContactSheet("name,phone\nJane,5559234567\n,,\n\n");
    expect(sheet.counts.total).toBe(1);
  });

  test("throws SheetParseError on an empty file", () => {
    expect(() => parseContactSheet("   \n  ")).toThrow(SheetParseError);
  });

  test("throws SheetParseError when only a header row is present", () => {
    expect(() => parseContactSheet("name,phone\n")).toThrow(
      /at least one contact row/i,
    );
  });

  test("throws SheetParseError when no phone column is recognizable", () => {
    expect(() => parseContactSheet("name,email\nJane,j@x.com\n")).toThrow(
      /no phone column/i,
    );
  });
});

describe("consent provenance columns", () => {
  it("captures consent source + date verbatim when the sheet has them", () => {
    const sheet = [
      "name,phone,consent source,consent date",
      'Ada Lovelace,(555) 000-0001,web form,2026-01-15',
      'Grace Hopper,(555) 000-0002,,',
    ].join("\n");

    const { contacts } = parseContactSheet(sheet);
    expect(contacts[0].consentSource).toBe("web form");
    expect(contacts[0].consentDate).toBe("2026-01-15");
    // blank cells → null, never empty strings
    expect(contacts[1].consentSource).toBeNull();
    expect(contacts[1].consentDate).toBeNull();
  });

  it("omits the consent keys entirely when the sheet has no consent columns", () => {
    const sheet = ["name,phone", "Ada Lovelace,(555) 000-0001"].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts[0]).not.toHaveProperty("consentSource");
    expect(contacts[0]).not.toHaveProperty("consentDate");
  });

  it("a lone consent-date column is not mistaken for the source (prefix hazard)", () => {
    const sheet = [
      "name,phone,consent date",
      "Ada Lovelace,(555) 000-0001,2026-01-15",
    ].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts[0].consentDate).toBe("2026-01-15");
    expect(contacts[0].consentSource).toBeNull();
  });

  it("recognizes opt-in variants and carries consent on invalid rows too (audit)", () => {
    const sheet = [
      "name,phone,opt-in source,opt-in date",
      "Bad Phone,123,card at front desk,Jan 2026",
    ].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts[0].reason).toBe("invalid");
    expect(contacts[0].consentSource).toBe("card at front desk");
    expect(contacts[0].consentDate).toBe("Jan 2026");
  });
});

describe("timezone column", () => {
  it("captures the timezone cell verbatim (never normalized here); blank → null", () => {
    const sheet = [
      "name,phone,timezone",
      "Ada Lovelace,(555) 000-0001, Pacific/Honolulu ",
      "Grace Hopper,(555) 000-0002,not-a-zone",
      "Katherine Johnson,(555) 000-0003,",
    ].join("\n");

    const parsed = parseContactSheet(sheet);
    expect(parsed.timezoneHeader).toBe("timezone");
    // Verbatim raw strings — the repo normalizes at ingest, not the parser.
    expect(parsed.contacts[0].timezone).toBe("Pacific/Honolulu");
    expect(parsed.contacts[1].timezone).toBe("not-a-zone");
    expect(parsed.contacts[2].timezone).toBeNull();
  });

  it("omits the timezone key entirely when the sheet has no timezone column", () => {
    const parsed = parseContactSheet("name,phone\nAda,(555) 000-0001\n");
    expect(parsed.timezoneHeader).toBeNull();
    expect(parsed.contacts[0]).not.toHaveProperty("timezone");
  });

  it('matches header variants ("Time Zone", "TZ", "zone") case-insensitively', () => {
    for (const header of ["Time Zone", "TZ", "zone", "Timezone (IANA)"]) {
      const parsed = parseContactSheet(
        `name,phone,${header}\nAda,(555) 000-0001,ET\n`,
      );
      expect(parsed.contacts[0].timezone, `header ${header}`).toBe("ET");
    }
  });

  it("carries timezone on invalid and duplicate rows too", () => {
    const sheet = [
      "name,phone,timezone",
      "Ada,(555) 000-0001,ET",
      "Ada Again,(555) 000-0001,CT",
      "Bad Phone,123,MT",
    ].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts[1]).toMatchObject({ reason: "duplicate", timezone: "CT" });
    expect(contacts[2]).toMatchObject({ reason: "invalid", timezone: "MT" });
  });
});

describe("email column", () => {
  it("captures the email cell verbatim-trimmed with a shape-check boolean; blank → null", () => {
    const sheet = [
      "name,phone,email",
      "Ada Lovelace,(555) 000-0001, ada@example.com ",
      "Grace Hopper,(555) 000-0002,not-an-email",
      "Katherine Johnson,(555) 000-0003,",
    ].join("\n");

    const parsed = parseContactSheet(sheet);
    expect(parsed.emailHeader).toBe("email");
    // Verbatim raw strings (trimmed) — validity is a separate boolean, the
    // value itself is never altered or rejected here.
    expect(parsed.contacts[0]).toMatchObject({
      email: "ada@example.com",
      emailValid: true,
    });
    expect(parsed.contacts[1]).toMatchObject({
      email: "not-an-email",
      emailValid: false,
    });
    expect(parsed.contacts[2]).toMatchObject({ email: null, emailValid: false });
  });

  it("the shape check needs BOTH @ and a dot", () => {
    const sheet = [
      "name,phone,email",
      "A,(555) 000-0001,a@b",
      "B,(555) 000-0002,a.b",
      "C,(555) 000-0003,a@b.co",
    ].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts.map((c) => c.emailValid)).toEqual([false, false, true]);
  });

  it('matches header variants ("Email", "E-mail", "Email Address") case-insensitively', () => {
    for (const header of ["Email", "E-mail", "EMAIL ADDRESS", "email (primary)"]) {
      const parsed = parseContactSheet(
        `name,phone,${header}\nAda,(555) 000-0001,ada@example.com\n`,
      );
      expect(parsed.contacts[0].email, `header ${header}`).toBe(
        "ada@example.com",
      );
    }
  });

  it("a valid email never rescues a bad phone — reason stays invalid, counts unchanged", () => {
    const sheet = [
      "name,phone,email",
      "Ada,(555) 000-0001,ada@example.com",
      "Bad Phone,123,bad@example.com",
    ].join("\n");
    const parsed = parseContactSheet(sheet);
    // Identical classification to the same sheet without the email column.
    expect(parsed.counts).toEqual({ ok: 1, invalid: 1, duplicate: 0, total: 2 });
    expect(parsed.contacts[1]).toMatchObject({
      phoneE164: null,
      reason: "invalid",
      email: "bad@example.com",
      emailValid: true,
    });
  });

  it("carries email on duplicate rows too (phone stays null)", () => {
    const sheet = [
      "name,phone,email",
      "Ada,(555) 000-0001,ada@example.com",
      "Ada Again,(555) 000-0001,again@example.com",
    ].join("\n");
    const { contacts } = parseContactSheet(sheet);
    expect(contacts[1]).toMatchObject({
      phoneE164: null,
      reason: "duplicate",
      email: "again@example.com",
    });
  });

  it("omits the email keys entirely when the sheet has no email column (output identical to before)", () => {
    const parsed = parseContactSheet("name,phone\nAda,(555) 000-0001\n");
    expect(parsed.emailHeader).toBeNull();
    expect(parsed.contacts[0]).not.toHaveProperty("email");
    expect(parsed.contacts[0]).not.toHaveProperty("emailValid");
    // Full pre-email row shape, byte-for-byte.
    expect(parsed.contacts[0]).toEqual({
      name: "Ada",
      firstName: "Ada",
      phoneE164: "+15550000001",
      rawPhone: "(555) 000-0001",
      reason: "ok",
    });
  });
});
