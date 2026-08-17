/**
 * Publishing the same video to YouTube, in the same minute as Instagram.
 *
 * A reel and a Short are the same file. It was going to one of them
 * automatically and the other by hand, later, which in practice meant days
 * later or not at all.
 *
 * **Why this is not part of the Instagram publisher.** Instagram is handed a
 * URL and fetches the file itself, so the portal can drive it from a
 * serverless function in a few hundred milliseconds. YouTube takes the bytes:
 * `videos.insert` is a resumable upload of the whole file, which is the one
 * thing a Vercel function cannot do — it has neither the time nor the memory
 * for a 200MB reel. So n8n does the upload, on the machine it already runs on,
 * holding the Google credential it already knows how to store. The portal
 * decides *what* and *when*; n8n does the carrying.
 *
 * **Why a separate queue rather than a step after Instagram.** They fail
 * independently. Meta rejecting a container should not hold back the Short,
 * a channel hitting its daily upload quota should not stop the reel, and a
 * client may well be on one platform and not the other. Both queues read the
 * same `scheduled_at`, which is what makes them go out together — not one
 * waiting on the other.
 *
 * Everything else deliberately mirrors `instagram.ts`: the same claim lease,
 * the same posting window, the same attempt budget, the same queue → claim →
 * result contract. Two publishers that behave differently under failure are
 * two things to learn instead of one.
 */
import "server-only";
import { onTheFloor } from "./client-status";
import { query, execute, queryOne, transaction, hasColumn } from "./db";
import { resolveVideoUrl } from "./storage";
import { nowUtc } from "./posting";
// Both from the Instagram publisher on purpose: the same window and the same
// caption, so the two platforms are due in the same minute and read alike.
import { composeCaption, PUBLISH_WINDOW_HOURS } from "./instagram";

export type YouTubeConnection =
  /** Uploads have actually landed on the channel. */
  | { state: "connected"; lastUrl: string | null; postedAt: string | null; channelId: string | null }
  /** Switched on, but nothing has gone out yet — so nothing proves it works. */
  | { state: "untested"; channelId: string | null }
  /** Switched off for this client. Not a fault. */
  | { state: "off" }
  | { state: "broken"; reason: string; failed: number };

/**
 * Whether this client's YouTube is really connected.
 *
 * Unlike Instagram and Facebook, this cannot be answered by asking Google.
 * The portal holds no YouTube credential at all — `videos.insert` is a
 * resumable upload of the whole file, so n8n does the carrying on the machine
 * that already stores the Google account. There is nothing here to
 * authenticate with, and a "Connected" badge derived from the `youtube_enabled`
 * tickbox would be a badge for having ticked a box.
 *
 * What the portal does hold is the record of what n8n actually did, which is
 * better evidence than a credential check anyway: a video with a
 * `youtube_video_id` is a video that is on the channel. So connected means
 * something has been published, and the last failure is shown when the recent
 * ones failed — that error text comes back from the Google API through n8n and
 * is the only place an expired channel authorisation ever surfaces.
 *
 * "Untested" is deliberately its own state rather than being folded into
 * either neighbour. Switched on with nothing published yet is the normal
 * condition of a client set up this morning, and calling that either
 * "Connected" or "Not connected" would be a guess in one direction or the
 * other.
 */
export async function checkYouTubeConnection(clientId: number): Promise<YouTubeConnection> {
  if (!(await hasColumn("clients", "youtube_enabled"))) return { state: "off" };

  const c = await queryOne<{ youtube_enabled: number | null; youtube_channel_id: string | null }>(
    "SELECT youtube_enabled, youtube_channel_id FROM clients WHERE id = ?",
    [clientId]
  );
  if (!c || Number(c.youtube_enabled) !== 1) return { state: "off" };
  const channelId = c.youtube_channel_id || null;

  if (!(await hasColumn("deliverables", "youtube_status"))) {
    return { state: "untested", channelId };
  }

  const row = await queryOne<{
    posted: number;
    failed: number;
    last_url: string | null;
    last_at: string | null;
    last_error: string | null;
  }>(
    `SELECT COALESCE(SUM(youtube_status = 'posted'),0) AS posted,
            COALESCE(SUM(youtube_status = 'failed'),0) AS failed,
            SUBSTRING_INDEX(GROUP_CONCAT(youtube_url ORDER BY youtube_posted_at DESC), ',', 1) AS last_url,
            MAX(youtube_posted_at) AS last_at,
            SUBSTRING_INDEX(GROUP_CONCAT(youtube_error ORDER BY id DESC), ',', 1) AS last_error
       FROM deliverables
      WHERE client_id = ?`,
    [clientId]
  );

  const posted = Number(row?.posted ?? 0);
  const failed = Number(row?.failed ?? 0);

  /*
   * One upload that worked outranks any number of failures. A channel that
   * has published is connected; the failures after it are this video's
   * problem — a file too large, a quota, a title the API refused — and
   * belong on that video's own page, not on a red badge about the account.
   */
  if (posted > 0) {
    return {
      state: "connected",
      lastUrl: row?.last_url || null,
      postedAt: row?.last_at ? String(row.last_at) : null,
      channelId,
    };
  }
  if (failed > 0) {
    return {
      state: "broken",
      reason: row?.last_error || "The upload failed and n8n gave no reason.",
      failed,
    };
  }
  return { state: "untested", channelId };
}

/** Attempts before a video is left alone for a person to look at. */
export const MAX_UPLOAD_ATTEMPTS = 3;

/** How long a claim holds before another run may take the row. */
export const CLAIM_LEASE_MINUTES = 30;

/**
 * How long a signed video URL stays valid.
 *
 * Longer than Instagram's, because n8n is downloading the whole file over
 * whatever connection the office has rather than Meta pulling it across a
 * datacentre. A link that expires mid-upload fails the post for a reason
 * nobody would think to look for.
 */
const SIGNED_URL_TTL_SECONDS = 12 * 60 * 60;

/** YouTube truncates past 100 characters, and rejects < > outright. */
const MAX_TITLE = 100;
/** The API's own limit. */
const MAX_DESCRIPTION = 5000;

export type YouTubeQueueItem = {
  deliverable_id: number;
  client_id: number;
  company_name: string;
  /** Where n8n downloads the file from. */
  video_url: string;
  title: string;
  description: string;
  tags: string[];
  privacy_status: "public" | "unlisted" | "private";
  /** Set when the client posts to one channel of several. */
  channel_id: string | null;
  scheduled_at: string;
  attempts: number;
};

export async function youtubeReadiness(): Promise<{ ready: boolean; reason?: string }> {
  if (!(await hasColumn("deliverables", "youtube_status"))) {
    return {
      ready: false,
      reason:
        "YouTube columns are missing. Run database/migrate.js, or apply them from Settings → Database.",
    };
  }
  return { ready: true };
}

/**
 * A YouTube title from the task's own title.
 *
 * Not the caption. An Instagram caption opens with a hook and carries the
 * hashtags; as a YouTube title that is a wall of text truncated at 100
 * characters, and the truncation lands mid-word in front of the client's
 * audience. The task title is already the short human name for the video.
 *
 * `<` and `>` are stripped rather than escaped — the API rejects a title
 * containing either, and no title needs them.
 */
export function youtubeTitle(title: string | null, isShort: boolean): string {
  const clean = String(title || "Untitled").replace(/[<>]/g, "").trim() || "Untitled";
  // #Shorts is what makes YouTube treat a vertical clip as a Short. It counts
  // against the 100, so the room for it is reserved before truncating rather
  // than bolted on after.
  const suffix = isShort ? " #Shorts" : "";
  const room = MAX_TITLE - suffix.length;
  const body = clean.length > room ? `${clean.slice(0, room - 1).trimEnd()}…` : clean;
  return `${body}${suffix}`;
}

/** The caption becomes the description, which is where it reads well. */
export function youtubeDescription(caption: string | null, hashtags: string | null): string {
  const text = composeCaption(caption, hashtags).replace(/[<>]/g, "");
  return text.length > MAX_DESCRIPTION ? text.slice(0, MAX_DESCRIPTION - 1) : text;
}

/**
 * Hashtags become tags.
 *
 * Same words, different field: in a YouTube description hashtags are decor,
 * in `tags` they are what the video is found by. The `#` goes, since the API
 * wants bare words, and the list is capped — YouTube counts the total length
 * of every tag against 500 characters and rejects the upload over it, which
 * would otherwise fail the post over a caption someone made enthusiastic.
 */
export function youtubeTags(hashtags: string | null): string[] {
  const words = String(hashtags || "")
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter((t) => t.length > 1 && t.length <= 30);

  const out: string[] = [];
  let budget = 450; // under 500, leaving room for the separators YouTube counts
  for (const w of words) {
    if (out.includes(w)) continue;
    if (budget - w.length < 0) break;
    out.push(w);
    budget -= w.length + 1;
    if (out.length >= 15) break;
  }
  return out;
}

/** A reel is a Short; anything else is an ordinary upload. */
const isShortFormat = (category: string | null) =>
  /reel|short/i.test(String(category || ""));

/**
 * Videos due on YouTube now.
 *
 * The same shape of question as the Instagram queue, against the same
 * `scheduled_at`, so both are due in the same minute. Read-only: nothing is
 * reserved until `claimForYouTube`.
 */
export async function getYouTubeQueue(limit = 10): Promise<YouTubeQueueItem[]> {
  const { ready } = await youtubeReadiness();
  if (!ready) return [];

  const rows = await query<{
    id: number;
    client_id: number;
    company_name: string;
    title: string;
    caption: string | null;
    hashtags: string | null;
    content_category: string | null;
    cloud_video_url: string | null;
    cloud_video_key: string | null;
    edited_link: string | null;
    scheduled_at: string;
    youtube_attempts: number;
    youtube_channel_id: string | null;
  }>(
    `SELECT d.id, d.client_id, c.company_name, d.title, d.caption, d.hashtags,
            d.content_category,
            d.cloud_video_url, d.cloud_video_key, d.edited_link,
            d.scheduled_at, d.youtube_attempts, c.youtube_channel_id
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
      WHERE ${onTheFloor()}
        AND c.youtube_enabled = 1
        -- Against the app's UTC, not NOW(): scheduled_at is written by the app
        -- in UTC and this database's clock is IST. youtube_locked_at below is
        -- written and read by the database on both sides, so it stays on NOW().
        AND d.scheduled_at IS NOT NULL AND d.scheduled_at <= ?
        -- A missed slot stops being due, exactly as on Instagram. Uploading a
        -- client's Short at 3am because the runner was down is worse than not
        -- uploading it.
        AND d.scheduled_at > DATE_SUB(?, INTERVAL ? HOUR)
        AND d.youtube_attempts < ?
        AND (
              d.youtube_status = 'scheduled'
           OR (d.youtube_status = 'processing'
               AND d.youtube_locked_at IS NOT NULL
               AND d.youtube_locked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
        )
        AND (d.cloud_video_key IS NOT NULL
             OR (d.cloud_video_url IS NOT NULL AND d.cloud_video_url <> '')
             OR (d.edited_link IS NOT NULL AND d.edited_link <> ''))
      ORDER BY d.scheduled_at ASC, d.id ASC
      LIMIT ${Number(limit) || 10}`,
    [nowUtc(), nowUtc(), PUBLISH_WINDOW_HOURS, MAX_UPLOAD_ATTEMPTS, CLAIM_LEASE_MINUTES]
  );

  const items: YouTubeQueueItem[] = [];
  for (const r of rows) {
    const videoUrl =
      (await resolveVideoUrl(r.cloud_video_key, r.cloud_video_url, SIGNED_URL_TTL_SECONDS)) ||
      r.edited_link;
    // No reachable file is not a failure to report — it is a row that should
    // never have matched, and handing n8n a null URL would burn an attempt.
    if (!videoUrl) continue;

    items.push({
      deliverable_id: r.id,
      client_id: r.client_id,
      company_name: r.company_name,
      video_url: videoUrl,
      title: youtubeTitle(r.title, isShortFormat(r.content_category)),
      description: youtubeDescription(r.caption, r.hashtags),
      tags: youtubeTags(r.hashtags),
      privacy_status: "public",
      channel_id: r.youtube_channel_id || null,
      scheduled_at: r.scheduled_at,
      attempts: Number(r.youtube_attempts) || 0,
    });
  }
  return items;
}

export type YouTubeClaim =
  | { ok: true; item: YouTubeQueueItem }
  | { ok: false; reason: "not_found" | "already_posted" | "exhausted" | "claimed_elsewhere" | "no_video" };

/**
 * Reserve one video for this run.
 *
 * The conditional UPDATE is the lock: two runs race, one gets
 * `affectedRows: 1` and the other gets zero and skips. Same primitive as the
 * Instagram claim, for the same reason — an upload that happens twice puts
 * two copies on the client's channel.
 */
export async function claimForYouTube(
  deliverableId: number,
  runId?: string | null
): Promise<YouTubeClaim> {
  const claimed = await transaction(async (conn) => {
    const [rows] = await conn.execute(
      "SELECT youtube_status, youtube_attempts FROM deliverables WHERE id = ? FOR UPDATE",
      [deliverableId]
    );
    const current = (rows as { youtube_status: string; youtube_attempts: number }[])[0];
    if (!current) return { ok: false, reason: "not_found" } as const;
    if (current.youtube_status === "posted") return { ok: false, reason: "already_posted" } as const;
    if (Number(current.youtube_attempts) >= MAX_UPLOAD_ATTEMPTS) {
      return { ok: false, reason: "exhausted" } as const;
    }

    const [res] = await conn.execute(
      `UPDATE deliverables
          SET youtube_status    = 'processing',
              youtube_locked_at = NOW(),
              youtube_attempts  = youtube_attempts + 1,
              youtube_error     = NULL
        WHERE id = ?
          AND youtube_status <> 'posted'
          AND (
                youtube_status = 'scheduled'
             OR (youtube_status = 'processing'
                 AND youtube_locked_at IS NOT NULL
                 AND youtube_locked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
          )`,
      [deliverableId, CLAIM_LEASE_MINUTES]
    );
    if ((res as { affectedRows: number }).affectedRows !== 1) {
      return { ok: false, reason: "claimed_elsewhere" } as const;
    }
    return { ok: true } as const;
  });

  if (!claimed.ok) return claimed;

  const r = await queryOne<{
    id: number;
    client_id: number;
    company_name: string;
    title: string;
    caption: string | null;
    hashtags: string | null;
    content_category: string | null;
    cloud_video_url: string | null;
    cloud_video_key: string | null;
    edited_link: string | null;
    scheduled_at: string;
    youtube_attempts: number;
    youtube_channel_id: string | null;
  }>(
    `SELECT d.id, d.client_id, c.company_name, d.title, d.caption, d.hashtags,
            d.content_category, d.cloud_video_url, d.cloud_video_key, d.edited_link,
            d.scheduled_at, d.youtube_attempts, c.youtube_channel_id
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  );
  if (!r) return { ok: false, reason: "not_found" };

  const videoUrl =
    (await resolveVideoUrl(r.cloud_video_key, r.cloud_video_url, SIGNED_URL_TTL_SECONDS)) ||
    r.edited_link;
  if (!videoUrl) {
    // Hand the row straight back rather than leaving it claimed for the lease.
    await execute(
      `UPDATE deliverables
          SET youtube_status = 'scheduled', youtube_locked_at = NULL,
              youtube_attempts = GREATEST(youtube_attempts - 1, 0)
        WHERE id = ?`,
      [deliverableId]
    );
    return { ok: false, reason: "no_video" };
  }

  void runId;
  return {
    ok: true,
    item: {
      deliverable_id: r.id,
      client_id: r.client_id,
      company_name: r.company_name,
      video_url: videoUrl,
      title: youtubeTitle(r.title, isShortFormat(r.content_category)),
      description: youtubeDescription(r.caption, r.hashtags),
      tags: youtubeTags(r.hashtags),
      privacy_status: "public",
      channel_id: r.youtube_channel_id || null,
      scheduled_at: r.scheduled_at,
      attempts: Number(r.youtube_attempts) || 0,
    },
  };
}

/**
 * What YouTube did, from the workflow.
 *
 * Idempotent in both directions: replaying a success for something already
 * posted changes nothing, and a late failure callback can never un-post a live
 * video. Whether a failure is worth retrying is decided here rather than in
 * the workflow, so it survives n8n being reimported or edited by hand.
 */
export async function recordYouTubeResult(input: {
  deliverableId: number;
  status: "posted" | "failed";
  videoId?: string | null;
  url?: string | null;
  errorMessage?: string | null;
  permanent?: boolean;
}): Promise<{ ok: boolean; state: string }> {
  const { ready } = await youtubeReadiness();
  if (!ready) return { ok: false, state: "not_migrated" };

  if (input.status === "posted") {
    const videoId = (input.videoId || "").trim() || null;
    const url = (input.url || "").trim() || (videoId ? `https://youtu.be/${videoId}` : null);
    await execute(
      `UPDATE deliverables
          SET youtube_status    = 'posted',
              youtube_video_id  = COALESCE(?, youtube_video_id),
              youtube_url       = COALESCE(?, youtube_url),
              youtube_posted_at = COALESCE(youtube_posted_at, NOW()),
              youtube_locked_at = NULL,
              youtube_error     = NULL
        WHERE id = ?`,
      [videoId, url, input.deliverableId]
    );
    return { ok: true, state: "posted" };
  }

  /*
   * A failure either waits for another go or stops here.
   *
   * Permanent means the workflow already knows another attempt cannot help —
   * a revoked credential, a channel that does not exist, a file YouTube
   * refuses. Everything else goes back to 'scheduled' and is picked up by the
   * next run, until the attempt budget runs out.
   */
  const message = (input.errorMessage || "Upload failed").slice(0, 1000);
  const row = await queryOne<{ youtube_attempts: number; youtube_status: string }>(
    "SELECT youtube_attempts, youtube_status FROM deliverables WHERE id = ?",
    [input.deliverableId]
  );
  if (!row) return { ok: false, state: "not_found" };
  if (row.youtube_status === "posted") return { ok: true, state: "posted" };

  const done = input.permanent || Number(row.youtube_attempts) >= MAX_UPLOAD_ATTEMPTS;
  await execute(
    `UPDATE deliverables
        SET youtube_status    = ?,
            youtube_error     = ?,
            youtube_locked_at = NULL
      WHERE id = ? AND youtube_status <> 'posted'`,
    [done ? "failed" : "scheduled", message, input.deliverableId]
  );
  return { ok: true, state: done ? "failed" : "scheduled" };
}

/** Put a failed upload back in the queue — the "try again" button. */
export async function retryYouTube(deliverableId: number): Promise<boolean> {
  const res = await execute(
    `UPDATE deliverables
        SET youtube_status = 'scheduled', youtube_attempts = 0,
            youtube_error = NULL, youtube_locked_at = NULL
      WHERE id = ? AND youtube_status <> 'posted'`,
    [deliverableId]
  );
  return res.affectedRows > 0;
}

/**
 * The YouTube half of scheduling a video, to merge into the same UPDATE that
 * schedules the Instagram post.
 *
 * Returns nothing at all unless the client is opted in and the column exists,
 * so a portal that has never been near YouTube writes exactly what it wrote
 * before. Already posted is left alone: that is history, not a queue entry.
 */
export function youtubeHandoff(current: {
  youtube_enabled?: number | null;
  youtube_status?: string | null;
}): Record<string, string> {
  if (Number(current.youtube_enabled) !== 1) return {};
  if (current.youtube_status === "posted") return {};
  return { youtube_status: "scheduled" };
}
