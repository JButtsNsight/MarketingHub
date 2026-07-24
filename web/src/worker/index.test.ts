// @vitest-environment node
import { describe, expect, test } from "vitest";

import { buildConfigFromEnv } from "./index";

/**
 * Only buildConfigFromEnv is unit-tested here — the run loop itself is wired
 * against real repo/sendSms deps and is exercised by the `node .worker/
 * worker.cjs` fail-loud smoke (the entrypoint call is guarded off under
 * vitest, so importing this module never starts the loop).
 */

describe("buildConfigFromEnv", () => {
  test("returns the documented defaults when nothing is set", () => {
    expect(buildConfigFromEnv({})).toEqual({
      pollMs: 30_000,
      batchSize: 25,
      claimTtlSeconds: 180,
      ratePerSecond: 2,
      maxAttempts: 3,
    });
  });

  test("honors the five env overrides", () => {
    expect(
      buildConfigFromEnv({
        SMS_POLL_INTERVAL_MS: "5000",
        SMS_CLAIM_BATCH: "10",
        SMS_SEND_RATE_PER_SEC: "5",
        SMS_CLAIM_TTL_S: "60",
        SMS_MAX_ATTEMPTS: "5",
      }),
    ).toEqual({
      pollMs: 5_000,
      batchSize: 10,
      claimTtlSeconds: 60,
      ratePerSecond: 5,
      maxAttempts: 5,
    });
  });

  test("non-numeric or non-positive values fall back to the defaults", () => {
    expect(
      buildConfigFromEnv({
        SMS_POLL_INTERVAL_MS: "soon",
        SMS_CLAIM_BATCH: "0",
        SMS_SEND_RATE_PER_SEC: "-2",
        SMS_CLAIM_TTL_S: "",
        SMS_MAX_ATTEMPTS: "lots",
      }),
    ).toEqual({
      pollMs: 30_000,
      batchSize: 25,
      claimTtlSeconds: 180,
      ratePerSecond: 2,
      maxAttempts: 3,
    });
  });
});
