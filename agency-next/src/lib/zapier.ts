/**
 * Data layer for the Zapier automation API (src/app/api/zapier/*).
 * Feeds a Zap: poll for approved, not-yet-posted video content, then post
 * back once Zapier has actually published it to Instagram.
 */
import "server-only";
import { query, queryOne, execute } from "./db";
import { notifyAdmins } from "./notify";

export type ZapierReadyItem = {
  id: number;
  title: string;
  caption: string | null;
  video_url: string;
  /**
   * Extracted Google Drive file id, or null if video_url isn't a recognisable
   * Drive link. A Drive "view" link returns an HTML page, not raw video bytes
   * — Instagram's API can't fetch it directly. Feed this into a Zap's
   * "Google Drive: Retrieve File or Folder by ID" step instead, so Zapier
   * fetches the real file regardless of how the link was pasted in.
   */
  drive_file_id: string | null;
  category: string | null;
  due_date: string | null;
  scheduled_at: string | null;
  client_id: number;
  client_name: string;
  /** Meta Graph IG business account id — maps directly to Zapier's "Instagram Account to Use" field. */
  instagram_account_id: string;
};

/** Pull the file id out of the common Google Drive share-link shapes. */
function extractDriveFileId(url: string): string | null {
  const patterns = [/\/d\/([a-zA-Z0-9_-]{10,})/, /[?&]id=([a-zA-Z0-9_-]{10,})/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
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
  india: { utcOffsetMinutes: 330, hour: 18 }, // 6:00 PM IST
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

/** Categories treated as "post to Instagram automatically once approved". */
export const AUTO_SCHEDULE_CATEGORIES = ["Instagram Reel"];

/**
 * Deliverables ready for unattended posting: client-approved, tagged with the
 * given category (default the "Instagram Reel" category from the video
 * service taxonomy), not already posted to Instagram, has a video link, and
 * the client has an Instagram Business account id on file.
 */
export async function getReadyToPostToInstagram(
  category = "Instagram Reel",
  limit = 25
): Promise<ZapierReadyItem[]> {
  const rows = await query<{
    id: number;
    title: string;
    caption: string | null;
    edited_link: string;
    content_category: string | null;
    due_date: string | null;
    scheduled_at: string | null;
    client_id: number;
    company_name: string;
    ig_user_id: string;
  }>(
    `SELECT d.id, d.title, d.caption, d.edited_link, d.content_category, d.due_date, d.scheduled_at,
            c.id AS client_id, c.company_name, c.ig_user_id
     FROM deliverables d
     JOIN clients c ON c.id = d.client_id
     WHERE c.status != 'churned'
       AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''
       AND (d.service = 'video_editing' OR (d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) <> 'poster'))
       AND d.content_category = ?
       AND d.status = 'scheduled'
       AND d.scheduled_at IS NOT NULL AND d.scheduled_at <= NOW()
       AND d.instagram_status != 'posted'
       AND d.edited_link IS NOT NULL AND d.edited_link <> ''
     ORDER BY d.scheduled_at ASC, d.id ASC
     LIMIT ${Number(limit)}`,
    [category]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    caption: r.caption,
    video_url: r.edited_link,
    drive_file_id: extractDriveFileId(r.edited_link),
    category: r.content_category,
    due_date: r.due_date,
    scheduled_at: r.scheduled_at,
    client_id: r.client_id,
    client_name: r.company_name,
    instagram_account_id: r.ig_user_id,
  }));
}

export type MarkPostedResult = { ok: boolean; error?: string; alreadyPosted?: boolean };

/** Record that Zapier successfully published a deliverable to Instagram. */
export async function markPostedToInstagram(
  deliverableId: number,
  mediaId?: string | null,
  permalink?: string | null
): Promise<MarkPostedResult> {
  const d = await queryOne<{ id: number; instagram_status: string; title: string }>(
    "SELECT id, instagram_status, title FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (d.instagram_status === "posted") return { ok: true, alreadyPosted: true };

  await execute(
    `UPDATE deliverables
     SET instagram_status = 'posted',
         posting_status = 'posted',
         status = IF(status NOT IN ('completed'), 'posted', status),
         posted_at = COALESCE(posted_at, NOW())
     WHERE id = ?`,
    [deliverableId]
  );

  await execute(
    `INSERT INTO activity_logs (actor_name, action, entity_type, entity_id, description, meta_json)
     VALUES ('Zapier automation', 'posted_to_instagram', 'deliverable', ?, ?, ?)`,
    [
      deliverableId,
      `"${d.title}" posted to Instagram automatically`,
      JSON.stringify({ instagram_media_id: mediaId ?? null, permalink: permalink ?? null }),
    ]
  );

  await notifyAdmins(
    "general",
    "Posted to Instagram",
    `"${d.title}" was auto-posted to Instagram via Zapier.`,
    `/deliverables/${deliverableId}`
  );

  return { ok: true };
}
