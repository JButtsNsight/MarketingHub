import { describe, expect, test } from "vitest";
import { CAMPAIGN_STATUSES, RECIPIENT_STATUSES } from "@/lib/sms/schema";
import { statusLabel, statusTone, type SmsStatus } from "./statusBadge";

const ALL_STATUSES: SmsStatus[] = [
  ...new Set<SmsStatus>([...CAMPAIGN_STATUSES, ...RECIPIENT_STATUSES]),
];

describe("statusTone", () => {
  test("failure statuses — and ONLY failure statuses — are red", () => {
    // Red (--fail) is reserved exclusively for failure in the design language.
    const red = ALL_STATUSES.filter((s) => statusTone(s) === "var(--fail)");
    expect(red.sort()).toEqual(
      ["failed", "failed_ambiguous", "undelivered"].sort(),
    );
  });

  test("actively-running statuses are the running blue", () => {
    expect(statusTone("sending")).toBe("var(--run)");
    expect(statusTone("claimed")).toBe("var(--run)");
  });

  test("successful outcomes are the ok green", () => {
    expect(statusTone("delivered")).toBe("var(--ok)");
    expect(statusTone("completed")).toBe("var(--ok)");
    expect(statusTone("sent")).toBe("var(--ok)");
  });

  test("paused is the warning tone", () => {
    expect(statusTone("paused")).toBe("var(--warn)");
  });

  test("waiting statuses render as the neutral badge (no tone)", () => {
    expect(statusTone("scheduled")).toBeUndefined();
    expect(statusTone("pending")).toBeUndefined();
  });

  test("inert terminal statuses are muted", () => {
    expect(statusTone("canceled")).toBe("var(--idle)");
    expect(statusTone("skipped")).toBe("var(--idle)");
    expect(statusTone("suppressed")).toBe("var(--idle)");
  });

  test("covers every campaign and recipient status", () => {
    // Exhaustiveness guard: a new DB status must be given a tone deliberately.
    for (const status of ALL_STATUSES) {
      expect(() => statusTone(status)).not.toThrow();
    }
  });
});

describe("statusLabel", () => {
  test("humanizes underscored statuses", () => {
    expect(statusLabel("failed_ambiguous")).toBe("failed ambiguous");
    expect(statusLabel("sent")).toBe("sent");
  });
});
