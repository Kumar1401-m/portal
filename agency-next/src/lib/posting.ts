/**
 * When a post goes out, and in whose clock.
 *
 * Everything about *timing*: the evening window each country posts in, and the
 * conversions between the date somebody picks on a form and the UTC timestamp
 * the publisher compares against. Publishing itself lives in
 * `instagram-publish.ts`; this module only decides when.
 *
 * Was `zapier.ts`. Zapier is gone — Instagram posting runs through n8n and the
 * portal's own publisher — but the scheduling half of that file was never
 * about Zapier and is used across the portal, so it kept the code and lost the
 * name.
 */
import "server-only";

/**
 * Now, as the MySQL DATETIME string every scheduled time in this portal is
 * stored in.
 *
 * The one clock. `scheduled_at` is written from here — by `scheduleDateToUtc`,
 * `localTimeToUtc`, `nextBestPostTime` — so the question "has this post's time
 * arrived?" must be asked against here too, and never against the database's
 * `NOW()`.
 *
 * That is not a hypothetical tidy-up. Nothing in the connection pins the
 * session timezone, so `NOW()` returns whatever wall clock the database server
 * happens to keep, and `dateStrings` hands it back as a bare string with no
 * zone on it. A database sitting in IST would report 11:05 while the app means
 * 11:05 UTC, and every scheduled post would be judged due five and a half
 * hours early — going out at half past eleven in the morning instead of five
 * in the evening, silently, on a live client account.
 *
 * Comparisons between two database-written columns are fine as they are; it is
 * only the app-written ones that must use this.
 */
export function nowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/* ------------------------- Best-engagement scheduling ------------------------- */

/**
 * Approximate "best time to post" by country, as a fixed UTC offset + local
 * hour. DST is intentionally ignored — being off by an hour a few weeks a
 * year is a fine trade-off for not pulling in a timezone-database dependency
 * for a "roughly evening, roughly local" heuristic. Matched against the
 * client's `placeholder_values.country` (the same field the AI caption
 * studio already uses for localization).
 */
/**
 * `hour` is when the post goes out; `untilHour` is when its window shuts.
 *
 * The window used to be one number for the whole portal — 5 to 7 PM, which is
 * India's — with a note saying a genuinely multi-country roster would want it
 * per country and would notice the day it did. An Australian client is that
 * day. Their reel goes out at 7 PM Sydney and stops being due at 8, and being
 * an hour late in Sydney is not the same event as being an hour late in
 * Hyderabad.
 *
 * `zone` is only ever printed, never calculated with, so it names the standard
 * offset the row is built on rather than pretending to track DST.
 */
type PostTiming = {
  utcOffsetMinutes: number;
  hour: number;
  minute?: number;
  untilHour: number;
  zone: string;
};

const COUNTRY_BEST_TIME: Record<string, PostTiming> = {
  india: { utcOffsetMinutes: 330, hour: 17, untilHour: 19, zone: "IST" }, // 5–7 PM
  usa: { utcOffsetMinutes: -300, hour: 19, untilHour: 20, zone: "ET" }, // 7–8 PM
  unitedstates: { utcOffsetMinutes: -300, hour: 19, untilHour: 20, zone: "ET" },
  america: { utcOffsetMinutes: -300, hour: 19, untilHour: 20, zone: "ET" },
  canada: { utcOffsetMinutes: -300, hour: 19, untilHour: 20, zone: "ET" },
  uk: { utcOffsetMinutes: 0, hour: 19, untilHour: 20, zone: "GMT" },
  unitedkingdom: { utcOffsetMinutes: 0, hour: 19, untilHour: 20, zone: "GMT" },
  britain: { utcOffsetMinutes: 0, hour: 19, untilHour: 20, zone: "GMT" },
  australia: { utcOffsetMinutes: 600, hour: 19, untilHour: 20, zone: "AEST" }, // 7–8 PM
  uae: { utcOffsetMinutes: 240, hour: 20, untilHour: 21, zone: "GST" },
  dubai: { utcOffsetMinutes: 240, hour: 20, untilHour: 21, zone: "GST" },
  emirates: { utcOffsetMinutes: 240, hour: 20, untilHour: 21, zone: "GST" },
  singapore: { utcOffsetMinutes: 480, hour: 19, untilHour: 20, zone: "SGT" },
};

/** India is both the primary market and the user's explicit default. */
const DEFAULT_TIMING = COUNTRY_BEST_TIME.india;

function normalizeCountryKey(country: string): string {
  return country.toLowerCase().replace(/[^a-z]/g, "");
}

function bestPostingTimeFor(country: string | null | undefined): PostTiming {
  if (!country) return DEFAULT_TIMING;
  const key = normalizeCountryKey(country);
  for (const [k, timing] of Object.entries(COUNTRY_BEST_TIME)) {
    if (key.includes(k) || k.includes(key)) return timing;
  }
  return DEFAULT_TIMING;
}

/**
 * Next occurrence (today if still ahead, otherwise tomorrow) of that
 * country's best local posting time, formatted as a MySQL DATETIME string.
 * Assumes the DB session clock is UTC (matches `nowStr()` elsewhere).
 */
export function nextBestPostTime(country: string | null | undefined): string {
  const t = bestPostingTimeFor(country);
  const now = new Date();
  const todayUtcMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), t.hour, t.minute ?? 0) -
    t.utcOffsetMinutes * 60000;
  let target = new Date(todayUtcMs);
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target.toISOString().slice(0, 19).replace("T", " ");
}

/** Countries offered when scheduling by hand, with their best-time default. */
export const POST_COUNTRIES: { key: string; label: string; offsetMinutes: number; hour: number }[] =
  [
    { key: "india", label: "India (IST)", offsetMinutes: 330, hour: 17 },
    { key: "usa", label: "United States (ET)", offsetMinutes: -300, hour: 19 },
    { key: "uk", label: "United Kingdom (GMT)", offsetMinutes: 0, hour: 19 },
    { key: "uae", label: "UAE / Dubai (GST)", offsetMinutes: 240, hour: 20 },
    { key: "singapore", label: "Singapore (SGT)", offsetMinutes: 480, hour: 19 },
    { key: "australia", label: "Australia (AEST)", offsetMinutes: 600, hour: 19 },
  ];

const offsetForCountry = (country: string | null | undefined) =>
  bestPostingTimeFor(country).utcOffsetMinutes;

/**
 * Turn a wall-clock time the user typed ("2026-08-02T18:00") into the UTC
 * DATETIME the scheduler compares against, reading it as local time in the
 * chosen country rather than the browser's own zone.
 */
export function localTimeToUtc(localValue: string, country: string | null | undefined): string | null {
  const m = localValue.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - offsetForCountry(country) * 60000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The evening window a post lands in, in the client's own clock.
 *
 * Scheduling is by date, not by date and time. Nobody was choosing a minute —
 * they were choosing a day and then typing an evening time onto it, which is a
 * decision already made and made the same way every time. The hour comes from
 * the country table above, and so does the hour it stops being due: a post
 * belongs to its window, and one that misses it waits for a person rather than
 * going out at midnight to an audience that is asleep.
 *
 * India is 5 to 7 PM; everywhere else on the roster is an hour, 7 to 8 PM
 * local. Both halves come from the same row, so a window cannot be widened on
 * one side only and quietly let posts drift outside what the agency told the
 * client.
 */
export function postingWindowFor(country: string | null | undefined): {
  fromHour: number;
  toHour: number;
  zone: string;
} {
  const t = bestPostingTimeFor(country);
  return { fromHour: t.hour, toHour: t.untilHour, zone: t.zone };
}

/** How long after its slot a post is still allowed out, in hours. */
export const windowHoursFor = (country: string | null | undefined): number => {
  const t = bestPostingTimeFor(country);
  return Math.max(1, t.untilHour - t.hour);
};

/**
 * The widest window on the roster.
 *
 * The publish queue filters in SQL, where the client's country is a JSON
 * column and the window is a per-row number — so it prefilters on the widest
 * any client could have and each row is then checked against its own. Over-
 * selecting and narrowing is safe; the reverse would drop a post that was
 * still due.
 */
export const MAX_WINDOW_HOURS = Math.max(
  ...Object.values(COUNTRY_BEST_TIME).map((t) => Math.max(1, t.untilHour - t.hour))
);

/** A picked date plus that country's evening slot, as a MySQL DATETIME in UTC. */
export function scheduleDateToUtc(
  date: string,
  country: string | null | undefined
): string | null {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number) as unknown as number[];
  const t = bestPostingTimeFor(country);
  const utcMs = Date.UTC(y, mo - 1, d, t.hour, t.minute ?? 0) - t.utcOffsetMinutes * 60000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

/** A stored UTC time as the date it falls on in the client's clock, for the date input. */
export function utcToLocalDateInput(
  utc: string | null,
  country: string | null | undefined
): string {
  return utcToLocalInput(utc, country).slice(0, 10);
}

/** "7:00 – 8:00 PM AEST" — the window a country's posts go out in. */
export function postingTimeLabel(country: string | null | undefined): string {
  const t = bestPostingTimeFor(country);
  const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
  const suffix = (h: number) => (h >= 12 ? "PM" : "AM");
  const from = `${h12(t.hour)}:${String(t.minute ?? 0).padStart(2, "0")}`;
  const to = `${h12(t.untilHour)}:00`;
  return suffix(t.hour) === suffix(t.untilHour)
    ? `${from} – ${to} ${suffix(t.hour)} ${t.zone}`
    : `${from} ${suffix(t.hour)} – ${to} ${suffix(t.untilHour)} ${t.zone}`;
}

/** The reverse, for showing a stored UTC time back in the country's clock. */
export function utcToLocalInput(utc: string | null, country: string | null | undefined): string {
  if (!utc) return "";
  const iso = utc.includes("T") ? utc : utc.replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + offsetForCountry(country) * 60000).toISOString().slice(0, 16);
}

/**
 * A stored UTC timestamp as "20 Aug 2026, 6:00 pm" in the client's clock.
 *
 * India, like the rest of the portal's scheduling. Worth a helper rather than
 * an inline `toLocaleString`, which would use the *server's* timezone — on
 * Vercel that is UTC, so it would faithfully reproduce the bug it is here to
 * fix.
 *
 * Lives here, beside the offset table it depends on, because two places need
 * it: the publish panel, and the assistant that tells a client in their own
 * WhatsApp group when their video goes out. The second is the one that must
 * not get it wrong — a page showing 11:30 for a 5pm slot is a bug someone
 * reports, a message telling the customer 11:30 is one they act on.
 */
export function prettyLocal(utc: string | null, country: string | null = "india"): string | null {
  if (!utc) return null;
  const local = utcToLocalInput(utc, country); // "2026-08-20T18:00"
  if (!local) return null;
  const [date, time] = local.split("T");
  const [h, m] = time.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const d = new Date(`${date}T00:00:00`);
  return (
    `${d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}, ` +
    `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`
  );
}

/** Just the time, no date: "7:00 pm". */
function clockOnly(utc: string, country: string | null | undefined): string {
  const local = utcToLocalInput(utc, country);
  const [h, m] = local.split("T")[1].split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * A posting time in the client's clock and, after it, in ours.
 *
 * "20 Aug 2026, 7:00 pm AEST · 2:30 pm IST".
 *
 * Both halves are needed and neither is optional. The client's is what the
 * post is *for* — an Australian reel goes out at 7 in Sydney because that is
 * when Sydney is looking, and telling that client 2:30 would be telling them
 * the wrong thing about their own account. The Indian one is when it actually
 * happens for the people who have to be awake if it fails.
 *
 * A client in India gets one time and no dot, because the same clock printed
 * twice reads as a bug.
 */
export function bothClocks(utc: string | null, country: string | null | undefined): string | null {
  if (!utc) return null;
  const theirs = prettyLocal(utc, country ?? "india");
  if (!theirs) return null;

  const zone = bestPostingTimeFor(country).zone;
  const ours = bestPostingTimeFor("india");
  if (bestPostingTimeFor(country).utcOffsetMinutes === ours.utcOffsetMinutes) {
    return `${theirs} ${zone}`;
  }
  return `${theirs} ${zone} · ${clockOnly(utc, "india")} ${ours.zone}`;
}

/** Categories treated as "post to Instagram automatically once approved". */
export const AUTO_SCHEDULE_CATEGORIES = ["Instagram Reel"];
