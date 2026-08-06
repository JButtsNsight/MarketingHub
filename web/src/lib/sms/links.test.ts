import { describe, expect, it } from "vitest";

import {
  extractUrls,
  generateSlug,
  rewriteWithTrackedLinks,
  SLUG_LENGTH,
} from "./links";

describe("extractUrls", () => {
  it("finds http and https URLs in order of appearance", () => {
    const text =
      "Book at https://book.example.com/slots and read http://example.com/faq today";
    expect(extractUrls(text)).toEqual([
      "https://book.example.com/slots",
      "http://example.com/faq",
    ]);
  });

  it("trims trailing sentence punctuation but keeps query strings and paths", () => {
    expect(
      extractUrls("Visit https://example.com/a?b=c&d=e."),
    ).toEqual(["https://example.com/a?b=c&d=e"]);
    expect(extractUrls("(see https://example.com/x), ok?")).toEqual([
      "https://example.com/x",
    ]);
  });

  it("returns empty for text without URLs and ignores bare schemes", () => {
    expect(extractUrls("Hi Sam, reply STOP to opt out")).toEqual([]);
    expect(extractUrls("broken link: https://")).toEqual([]);
  });
});

describe("generateSlug", () => {
  it("emits base62 slugs of the configured length", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateSlug()).toMatch(
        new RegExp(`^[0-9A-Za-z]{${SLUG_LENGTH}}$`),
      );
    }
  });

  it("does not repeat across a reasonable sample", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => generateSlug()),
    );
    expect(seen.size).toBe(200);
  });
});

describe("rewriteWithTrackedLinks", () => {
  const slugs = ["AAAAAAA1", "AAAAAAA2", "AAAAAAA3"];
  const makeSlug = () => {
    const next = slugs.shift();
    if (!next) throw new Error("test slug pool exhausted");
    return next;
  };

  it("replaces each URL occurrence with its own short link and reports the pairs", () => {
    slugs.splice(0, slugs.length, "s1s1s1s1", "s2s2s2s2");
    const result = rewriteWithTrackedLinks(
      "Book https://book.example.com/a or https://book.example.com/a today",
      "https://mh.example.com",
      makeSlug,
    );
    expect(result.text).toBe(
      "Book https://mh.example.com/l/s1s1s1s1 or https://mh.example.com/l/s2s2s2s2 today",
    );
    expect(result.links).toEqual([
      { slug: "s1s1s1s1", targetUrl: "https://book.example.com/a" },
      { slug: "s2s2s2s2", targetUrl: "https://book.example.com/a" },
    ]);
  });

  it("keeps trailing punctuation outside the rewritten link", () => {
    slugs.splice(0, slugs.length, "s1s1s1s1");
    const result = rewriteWithTrackedLinks(
      "See https://example.com/promo.",
      "https://mh.example.com/",
      makeSlug,
    );
    expect(result.text).toBe("See https://mh.example.com/l/s1s1s1s1.");
    expect(result.links).toEqual([
      { slug: "s1s1s1s1", targetUrl: "https://example.com/promo" },
    ]);
  });

  it("leaves text without URLs untouched and reports no links", () => {
    const result = rewriteWithTrackedLinks(
      "Hi Sam, reply STOP to opt out",
      "https://mh.example.com",
      makeSlug,
    );
    expect(result.text).toBe("Hi Sam, reply STOP to opt out");
    expect(result.links).toEqual([]);
  });

  it("never double-wraps links already under the base (idempotence)", () => {
    const result = rewriteWithTrackedLinks(
      "Already short: https://mh.example.com/l/abcd1234",
      "https://mh.example.com",
      makeSlug,
    );
    expect(result.text).toBe(
      "Already short: https://mh.example.com/l/abcd1234",
    );
    expect(result.links).toEqual([]);
  });

  it("ignores bare schemes", () => {
    const result = rewriteWithTrackedLinks(
      "broken: https:// end",
      "https://mh.example.com",
      makeSlug,
    );
    expect(result.text).toBe("broken: https:// end");
    expect(result.links).toEqual([]);
  });
});
