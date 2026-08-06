import type { CampaignStatus, SmsCampaignRecipient } from "../lib/sms/schema";
import type { SendResult, SendSmsInput } from "../lib/simpletexting/client";

/**
 * SMS dispatcher — the poll loop body that drains the durable outbox.
 *
 * Every dependency (repo accessors, sendSms, sleep, now) is injected so tests
 * drive a tick deterministically with fake deps and no real timers. The
 * at-most-once-per-attempt semantics live in the ORDER of operations here:
 *
 *   promoteDueCampaigns → drain loop {
 *     claimDueRecipients → getCampaignStatuses (once per batch) → per row:
 *       release if campaign left `sending` or we are shutting down;
 *       belt-and-suspenders STOP-list check;
 *       conditional markSending(attempts+1) — a null return means pause/
 *       cancel released the claim first: the row is SKIPPED with NO POST;
 *       sendSms (the only side effect that cannot be rolled back);
 *       classify the SendResult into exactly one settlement.
 *   } → completeDrainedCampaigns
 *
 * Nothing here imports server-only modules — the worker bundle and the tests
 * both consume this file directly.
 */

export interface DispatcherConfig {
  /** Idle delay between poll ticks (used by the run loop in index.ts). */
  pollMs: number;
  /** Rows claimed per claim RPC call. */
  batchSize: number;
  /** Claim TTL handed to the claim RPC (crash-recovery horizon). */
  claimTtlSeconds: number;
  /** Sequential POST throttle: sleep(1000 / ratePerSecond) between sends. */
  ratePerSecond: number;
  /** POST attempts a recipient may consume before `failed`. */
  maxAttempts: number;
  /**
   * Frequency cap, enforced inside the claim RPC: a due row whose phone
   * already received `frequencyCapCount` messages in the last
   * `frequencyCapDays` days is parked as `frequency_capped` instead of
   * claimed. Either value 0 disables the cap entirely (the default).
   */
  frequencyCapCount: number;
  frequencyCapDays: number;
}

/** Injected dependencies — shapes match `lib/sms/repo` and `sendSms` exactly. */
export interface DispatcherDeps {
  promoteDueCampaigns(now: Date): Promise<string[]>;
  claimDueRecipients(
    batchSize: number,
    claimTtlSeconds: number,
    freqCapCount: number,
    freqCapDays: number,
  ): Promise<SmsCampaignRecipient[]>;
  getCampaignStatuses(ids: string[]): Promise<Map<string, CampaignStatus>>;
  isSuppressed(phone: string): Promise<boolean>;
  suppressActiveRecipientsByPhone(phone: string): Promise<number>;
  markSending(
    id: string,
    nextAttempts: number,
  ): Promise<SmsCampaignRecipient | null>;
  markSent(
    id: string,
    result: { stMessageId: string | null; stCredits: number | null },
  ): Promise<SmsCampaignRecipient | null>;
  markFailed(id: string, detail: string): Promise<SmsCampaignRecipient | null>;
  markRetry(
    id: string,
    sendAfter: Date,
    detail: string,
  ): Promise<SmsCampaignRecipient | null>;
  markAmbiguous(
    id: string,
    detail: string,
  ): Promise<SmsCampaignRecipient | null>;
  releaseClaim(id: string): Promise<SmsCampaignRecipient | null>;
  releaseForConfigError(
    id: string,
    revertAttempts: number,
    detail: string,
  ): Promise<SmsCampaignRecipient | null>;
  completeDrainedCampaigns(): Promise<string[]>;
  sendSms(input: SendSmsInput): Promise<SendResult>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

/** Per-tick counters — index.ts logs one structured line from these. */
export interface TickStats {
  promoted: number;
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  ambiguous: number;
  released: number;
  suppressed: number;
  configErrors: number;
  completed: number;
}

export interface Dispatcher {
  /** One poll tick: promote → drain the due outbox → complete campaigns. */
  tick(): Promise<TickStats>;
  /** SIGTERM path: finish the in-flight POST, release the rest, exit tick. */
  requestShutdown(): void;
  isShuttingDown(): boolean;
}

/** Retry backoff base: 60s · 2^(attempts−1). */
const RETRY_BACKOFF_BASE_MS = 60_000;
/** A bad token affects every row — long pause instead of burning attempts. */
const CONFIG_ERROR_BACKOFF_MS = 5 * 60_000;
/** Cool-off when more than half of a batch's POSTs errored. */
const BACKPRESSURE_SLEEP_MS = 60_000;

export function createDispatcher(
  deps: DispatcherDeps,
  config: DispatcherConfig,
): Dispatcher {
  let shuttingDown = false;
  const throttleMs = 1000 / config.ratePerSecond;

  async function tick(): Promise<TickStats> {
    const stats: TickStats = {
      promoted: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      ambiguous: 0,
      released: 0,
      suppressed: 0,
      configErrors: 0,
      completed: 0,
    };

    stats.promoted = (await deps.promoteDueCampaigns(deps.now())).length;

    drain: while (!shuttingDown) {
      const batch = await deps.claimDueRecipients(
        config.batchSize,
        config.claimTtlSeconds,
        config.frequencyCapCount,
        config.frequencyCapDays,
      );
      if (batch.length === 0) break;
      stats.claimed += batch.length;

      // One status fetch per batch — the per-row check below is what turns a
      // mid-batch pause/cancel into releases instead of sends.
      const campaignStatuses = await deps.getCampaignStatuses(
        batch.map((row) => row.campaign_id),
      );

      let attempted = 0;
      let errored = 0;

      for (let i = 0; i < batch.length; i += 1) {
        const row = batch[i];

        // Shutdown or a campaign that left `sending`: hand the claim back
        // untouched. The claim was never attempted, so pending is truthful.
        if (
          shuttingDown ||
          campaignStatuses.get(row.campaign_id) !== "sending"
        ) {
          await deps.releaseClaim(row.id);
          stats.released += 1;
          continue;
        }

        const phone = row.phone_e164;
        if (!phone) {
          // Outbox invariant breach (claimable rows always carry a phone —
          // null-phone rows are created as `skipped`). Burn the attempt via
          // the guarded transition and fail the row rather than loop on it.
          if (await deps.markSending(row.id, row.attempts + 1)) {
            await deps.markFailed(
              row.id,
              "dispatcher: claimed row has no phone_e164 (outbox invariant breach)",
            );
            stats.failed += 1;
          }
          continue;
        }

        // Belt-and-suspenders STOP check (also enforced at creation and in
        // the claim RPC) — a STOP that landed after claiming still wins.
        if (await deps.isSuppressed(phone)) {
          await deps.suppressActiveRecipientsByPhone(phone);
          stats.suppressed += 1;
          continue;
        }

        // The durable claimed → sending transition STARTS the attempt. A null
        // return means pause/cancel released the row first — skip, NO POST.
        const nextAttempts = row.attempts + 1;
        const sending = await deps.markSending(row.id, nextAttempts);
        if (!sending) continue;

        const result = await deps.sendSms({ phone, text: row.rendered_text });
        attempted += 1;

        if (result.kind === "config") {
          // Credentials problem: this attempt never really happened. Revert
          // the attempt count, hand back the rest of the batch, and back off
          // long — a bad token must not burn a campaign to `failed`.
          stats.configErrors += 1;
          await deps.releaseForConfigError(row.id, row.attempts, result.detail);
          for (const rest of batch.slice(i + 1)) {
            await deps.releaseClaim(rest.id);
            stats.released += 1;
          }
          if (!shuttingDown) await deps.sleep(CONFIG_ERROR_BACKOFF_MS);
          break drain;
        }

        switch (result.kind) {
          case "sent":
            await deps.markSent(row.id, {
              stMessageId: result.id,
              stCredits: result.credits,
            });
            stats.sent += 1;
            break;
          case "permanent":
            await deps.markFailed(row.id, result.detail);
            stats.failed += 1;
            errored += 1;
            break;
          case "retryable":
            if (nextAttempts < config.maxAttempts) {
              const backoffMs =
                RETRY_BACKOFF_BASE_MS * 2 ** (nextAttempts - 1);
              await deps.markRetry(
                row.id,
                new Date(deps.now().getTime() + backoffMs),
                result.detail,
              );
              stats.retried += 1;
            } else {
              await deps.markFailed(
                row.id,
                `retries exhausted after ${nextAttempts} attempts: ${result.detail}`,
              );
              stats.failed += 1;
            }
            errored += 1;
            break;
          case "ambiguous":
            // The POST may have landed — park for webhook reconciliation or
            // manual review. NEVER auto-retried.
            await deps.markAmbiguous(row.id, result.detail);
            stats.ambiguous += 1;
            errored += 1;
            break;
        }

        // Sequential throttle between POSTs (undocumented ST rate limits).
        await deps.sleep(throttleMs);
      }

      // Backpressure: most of the batch erroring suggests a systemic problem
      // (carrier issues, sustained 429s) — cool off before claiming more.
      if (!shuttingDown && attempted > 0 && errored * 2 > attempted) {
        await deps.sleep(BACKPRESSURE_SLEEP_MS);
      }
    }

    stats.completed = (await deps.completeDrainedCampaigns()).length;
    return stats;
  }

  return {
    tick,
    requestShutdown() {
      shuttingDown = true;
    },
    isShuttingDown() {
      return shuttingDown;
    },
  };
}
