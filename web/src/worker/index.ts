/**
 * SMS dispatcher worker entrypoint — bundled by `npm run build:worker` into
 * `.worker/worker.cjs` and run as its own ECS service (same image as the app,
 * command override `['worker.cjs']`).
 *
 * Wires the real repo accessors + SimpleTexting client into the deterministic
 * dispatcher from ./dispatcher and loops forever:
 *
 * - missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → fail-loud crash at
 *   startup (the outbox is unreachable; ECS restarting us is correct);
 * - missing SIMPLETEXTING_API_TOKEN → idle-with-warning loop (healthy task,
 *   graceful degradation — no claims are made until the token is configured);
 * - SIGTERM/SIGINT → finish the in-flight POST, release un-attempted claims,
 *   exit the loop cleanly;
 * - one structured (JSON) log line per tick with the send counters.
 */

import {
  createDispatcher,
  type DispatcherConfig,
  type DispatcherDeps,
} from "./dispatcher";
import {
  claimDueRecipients,
  completeDrainedCampaigns,
  getCampaignStatuses,
  isSuppressed,
  markAmbiguous,
  markFailed,
  markRetry,
  markSending,
  markSent,
  promoteDueCampaigns,
  releaseClaim,
  releaseForConfigError,
  suppressActiveRecipientsByPhone,
} from "../lib/sms/repo";
import {
  isSimpleTextingConfigured,
  sendSms,
} from "../lib/simpletexting/client";

const DEFAULTS: DispatcherConfig = {
  pollMs: 30_000,
  batchSize: 25,
  claimTtlSeconds: 180,
  ratePerSecond: 2,
  maxAttempts: 3,
  // 0 = frequency cap disabled (claim behavior identical to pre-cap).
  frequencyCapCount: 0,
  frequencyCapDays: 0,
};

/**
 * Positive finite number from an env string, else the default. Fractional is
 * fine here — these values only feed JS math (sleep ms, 1000/rate throttle).
 */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The integer helpers guard values that travel to the claim RPC's int
// parameters, where a fractional value ('0.5'::int) is a 22P02 that would
// crash every tick and restart-loop the worker.

/** Positive integer from an env string, else the default. */
function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Non-negative integer from an env string, else the default (0 = off). */
function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Dispatcher config from env with documented defaults (see the plan doc). */
export function buildConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DispatcherConfig {
  return {
    pollMs: positiveNumber(env.SMS_POLL_INTERVAL_MS, DEFAULTS.pollMs),
    batchSize: positiveInteger(env.SMS_CLAIM_BATCH, DEFAULTS.batchSize),
    claimTtlSeconds: positiveInteger(
      env.SMS_CLAIM_TTL_S,
      DEFAULTS.claimTtlSeconds,
    ),
    ratePerSecond: positiveNumber(
      env.SMS_SEND_RATE_PER_SEC,
      DEFAULTS.ratePerSecond,
    ),
    maxAttempts: positiveInteger(env.SMS_MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    frequencyCapCount: nonNegativeInteger(
      env.SMS_FREQ_CAP_COUNT,
      DEFAULTS.frequencyCapCount,
    ),
    frequencyCapDays: nonNegativeInteger(
      env.SMS_FREQ_CAP_DAYS,
      DEFAULTS.frequencyCapDays,
    ),
  };
}

/** Fail-loud env check at startup — never idle without a reachable outbox. */
function requireWorkerEnv(
  name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY",
): void {
  if (!process.env[name]) {
    throw new Error(
      `[sms-worker] Missing required env ${name} — the dispatcher cannot ` +
        `reach the outbox without it.`,
    );
  }
}

/**
 * Interruptible sleep: a signal wakes the current sleep so shutdown never
 * waits out a full poll interval. The worker is strictly sequential, so at
 * most one sleep is pending at a time.
 */
let wake: (() => void) | null = null;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

function logLine(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));
}

async function main(): Promise<void> {
  requireWorkerEnv("SUPABASE_URL");
  requireWorkerEnv("SUPABASE_SERVICE_ROLE_KEY");

  const config = buildConfigFromEnv();
  const deps: DispatcherDeps = {
    promoteDueCampaigns,
    claimDueRecipients,
    getCampaignStatuses,
    isSuppressed,
    suppressActiveRecipientsByPhone,
    markSending,
    markSent,
    markFailed,
    markRetry,
    markAmbiguous,
    releaseClaim,
    releaseForConfigError,
    completeDrainedCampaigns,
    sendSms,
    sleep,
    now: () => new Date(),
  };
  const dispatcher = createDispatcher(deps, config);

  const onSignal = (signal: NodeJS.Signals) => {
    logLine({
      msg: "sms-dispatcher shutdown requested — finishing in-flight send, releasing un-attempted claims",
      signal,
    });
    dispatcher.requestShutdown();
    wake?.();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  logLine({ msg: "sms-dispatcher started", ...config });

  while (!dispatcher.isShuttingDown()) {
    if (!isSimpleTextingConfigured()) {
      // Graceful degradation: healthy task, no claims, loud about why.
      logLine({
        msg: "sms-dispatcher idle: SIMPLETEXTING_API_TOKEN is not configured — no recipients will be claimed",
        level: "warn",
      });
      await sleep(config.pollMs);
      continue;
    }

    const stats = await dispatcher.tick();
    logLine({ msg: "sms-dispatcher tick", ...stats });

    if (!dispatcher.isShuttingDown()) await sleep(config.pollMs);
  }

  logLine({ msg: "sms-dispatcher stopped cleanly" });
}

// Entrypoint call, guarded off under vitest so importing this module in a
// test never starts the loop. The bundle smoke test exercises this path.
if (!process.env.VITEST) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
