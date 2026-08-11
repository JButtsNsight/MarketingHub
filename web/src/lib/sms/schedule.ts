// Pure, dependency-free module — imported by client components and the
// worker alike. DST is resolved with Intl.DateTimeFormat (the runtime's IANA
// tz data), not a timezone library and never the server's local timezone.

const SEND_HOUR_ET = 11;
const SEND_MINUTE_ET = 30;
const EASTERN = "America/New_York";

/** The US send zones a blast can be scheduled in. */
export const SEND_TIMEZONES = [
  { id: "America/New_York", label: "Eastern", abbr: "ET" },
  { id: "America/Chicago", label: "Central", abbr: "CT" },
  { id: "America/Denver", label: "Mountain", abbr: "MT" },
  { id: "America/Los_Angeles", label: "Pacific", abbr: "PT" },
  { id: "Pacific/Honolulu", label: "Hawaii", abbr: "HT" },
] as const;
export type SendTimezone = (typeof SEND_TIMEZONES)[number]["id"];
export const SEND_TIMEZONE_IDS = SEND_TIMEZONES.map((z) => z.id) as [
  SendTimezone,
  ...SendTimezone[],
];

/**
 * The blast window: 8:00 AM through 1:00 PM in the schedule's chosen zone,
 * in 30-minute slots (11 slots). Same wall-clock window in every zone.
 */
export const SEND_SLOTS = [
  "08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
  "11:00", "11:30", "12:00", "12:30", "13:00",
] as const;
export type SendSlot = (typeof SEND_SLOTS)[number];

/** "08:30" → "8:30 AM", "13:00" → "1:00 PM" (display form of a slot). */
export function formatSlot(slot: string): string {
  const [h, m] = slot.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Zone abbreviation for display ("America/Chicago" → "CT"); id if unknown. */
export function zoneAbbr(timeZone: string): string {
  return SEND_TIMEZONES.find((z) => z.id === timeZone)?.abbr ?? timeZone;
}

/**
 * Whether `sendDate` (YYYY-MM-DD, taken as a wall-clock calendar date) is a
 * Monday–Friday. The weekday of a calendar date is zone-independent.
 */
export function isWeekday(sendDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sendDate);
  if (!match) return false;
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return day >= 1 && day <= 5;
}

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
 * The UTC instant of `sendTime` (HH:MM wall clock) in `timeZone` on
 * `sendDate` (`YYYY-MM-DD`). DST-aware — including the transition days
 * themselves (every slot in the 8:00–13:00 window is hours past the 2 AM
 * switch, so a slot is never a skipped or ambiguous wall-clock time).
 *
 * Technique: guess the instant assuming a UTC wall clock, ask Intl what the
 * guess reads as in the zone, correct by the difference, and re-check once —
 * two iterations always converge for a fixed daytime target.
 *
 * @throws on malformed input or impossible calendar dates.
 */
export function sendAtForZonedSlot(
  sendDate: string,
  sendTime: string,
  timeZone: string,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sendDate);
  if (!match) {
    throw new Error(
      `[sms] sendDate must be YYYY-MM-DD, got ${JSON.stringify(sendDate)}`,
    );
  }
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(sendTime);
  if (!timeMatch) {
    throw new Error(
      `[sms] sendTime must be HH:MM, got ${JSON.stringify(sendTime)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const wallClockTargetUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number(timeMatch[1]),
    Number(timeMatch[2]),
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

  let instant = wallClockTargetUtc; // guess as if the zone ran on UTC
  for (let i = 0; i < 2; i += 1) {
    instant =
      wallClockTargetUtc - timeZoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/**
 * The EARLIEST instant of `sendTime` on `sendDate` across an audience's
 * zones — `null` entries (and an empty audience) mean `fallbackZone`. The
 * past-slot checks validate this: a multi-zone audience's first send is its
 * easternmost zone's, which can precede the fallback zone's slot.
 */
export function earliestZonedSendAt(
  sendDate: string,
  sendTime: string,
  fallbackZone: string,
  zones: ReadonlyArray<string | null>,
): Date {
  const distinct = Array.from(
    new Set(
      zones.length > 0 ? zones.map((z) => z ?? fallbackZone) : [fallbackZone],
    ),
  );
  return distinct
    .map((zone) => sendAtForZonedSlot(sendDate, sendTime, zone))
    .reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

/**
 * The UTC instant of 11:30 AM America/New_York on `sendDate` — the fixed
 * pre-scheduling slot, kept for legacy callers and as the migration default.
 */
export function sendAtForEasternDate(sendDate: string): Date {
  return sendAtForZonedSlot(
    sendDate,
    `${String(SEND_HOUR_ET).padStart(2, "0")}:${String(SEND_MINUTE_ET).padStart(2, "0")}`,
    EASTERN,
  );
}
