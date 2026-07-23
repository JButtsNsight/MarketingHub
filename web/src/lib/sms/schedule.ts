// Pure, dependency-free module — imported by client components and the
// worker alike. DST is resolved with Intl.DateTimeFormat (the runtime's IANA
// tz data), not a timezone library and never the server's local timezone.

const SEND_HOUR_ET = 11;
const SEND_MINUTE_ET = 30;
const EASTERN = "America/New_York";

/** What wall-clock time `date` reads as in `timeZone`, re-encoded as a UTC ms
 * value. `offset = wallClockAsUtc - actualUtc` (EST → -5h, EDT → -4h). */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`[sms] formatToParts missing ${type}`);
    return Number(part.value);
  };
  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24, // some ICU builds render midnight as "24"
    get("minute"),
    get("second"),
  );
  return wallClockAsUtc - date.getTime();
}

/**
 * The UTC instant of 11:30 AM America/New_York on `sendDate` (`YYYY-MM-DD`).
 * DST-aware: 15:30Z during EDT, 16:30Z during EST — including the transition
 * days themselves (11:30 is hours past the 2 AM switch, so it is never a
 * skipped or ambiguous wall-clock time).
 *
 * Technique: guess the instant assuming a UTC wall clock, ask Intl what the
 * guess reads as in New York, correct by the difference, and re-check once —
 * two iterations always converge for a fixed 11:30 target.
 *
 * @throws on malformed input or impossible calendar dates.
 */
export function sendAtForEasternDate(sendDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sendDate);
  if (!match) {
    throw new Error(
      `[sms] sendDate must be YYYY-MM-DD, got ${JSON.stringify(sendDate)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const wallClockTargetUtc = Date.UTC(
    year,
    month - 1,
    day,
    SEND_HOUR_ET,
    SEND_MINUTE_ET,
    0,
  );
  const roundTrip = new Date(wallClockTargetUtc);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`[sms] sendDate is not a real calendar date: ${sendDate}`);
  }

  let instant = wallClockTargetUtc; // guess as if New York ran on UTC
  for (let i = 0; i < 2; i += 1) {
    instant =
      wallClockTargetUtc - timeZoneOffsetMs(new Date(instant), EASTERN);
  }
  return new Date(instant);
}
