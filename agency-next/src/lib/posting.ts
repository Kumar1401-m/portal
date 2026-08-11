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
type PostTiming = { utcOffsetMinutes: number; hour: number; minute?: number };

const COUNTRY_BEST_TIME: Record<string, PostTiming> = {
  india: { utcOffsetMinutes: 330, hour: 17 }, // 5:00 PM IST
  usa: { utcOffsetMinutes: -300, hour: 19 }, // 7:00 PM ET
  unitedstates: { utcOffsetMinutes: -300, hour: 19 },
  america: { utcOffsetMinutes: -300, hour: 19 },
  canada: { utcOffsetMinutes: -300, hour: 19 }, // 7:00 PM ET
  uk: { utcOffsetMinutes: 0, hour: 19 }, // 7:00 PM GMT
  unitedkingdom: { utcOffsetMinutes: 0, hour: 19 },
  britain: { utcOffsetMinutes: 0, hour: 19 },
  australia: { utcOffsetMinutes: 600, hour: 19 }, // 7:00 PM AEST
  uae: { utcOffsetMinutes: 240, hour: 20 }, // 8:00 PM Gulf
  dubai: { utcOffsetMinutes: 240, hour: 20 },
  emirates: { utcOffsetMinutes: 240, hour: 20 },
  singapore: { utcOffsetMinutes: 480, hour: 19 }, // 7:00 PM SGT
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
 * The evening window every post lands in: 5 PM to 7 PM, the client's clock.
 *
 * Scheduling is by date, not by date and time. Nobody was choosing a minute —
 * they were choosing a day and then typing an evening time onto it, which is a
 * decision already made and made the same way every time. The hour comes from
 * the country table above.
 *
 * Two hours wide, and `PUBLISH_WINDOW_HOURS` matches it: a post belongs to its
 * window, and one that misses it waits for a person rather than going out at
 * midnight. Widening one without the other would let posts drift outside the
 * window the agency tells its clients about.
 *
 * The other countries sit at 7 PM and 8 PM local, outside this range — it
 * describes the Indian window, which is where every client currently is. A
 * genuinely multi-country roster would want this per country, and would notice
 * the day it did.
 */
export const POSTING_WINDOW = { fromHour: 17, toHour: 19 } as const;

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

/** "5:00 PM" — the slot a country's posts go out in, for saying so on screen. */
export function postingTimeLabel(country: string | null | undefined): string {
  const t = bestPostingTimeFor(country);
  const h = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const suffix = t.hour >= 12 ? "PM" : "AM";
  return `${h}:${String(t.minute ?? 0).padStart(2, "0")} ${suffix}`;
}

/** The reverse, for showing a stored UTC time back in the country's clock. */
export function utcToLocalInput(utc: string | null, country: string | null | undefined): string {
  if (!utc) return "";
  const iso = utc.includes("T") ? utc : utc.replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + offsetForCountry(country) * 60000).toISOString().slice(0, 16);
}

/** Categories treated as "post to Instagram automatically once approved". */
export const AUTO_SCHEDULE_CATEGORIES = ["Instagram Reel"];
