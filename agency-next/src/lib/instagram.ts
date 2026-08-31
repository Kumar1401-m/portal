/**
 * Instagram auto-publishing — the portal's half of the n8n workflow.
 *
 * The workflow is deliberately dumb: it polls, claims, talks to the Meta Graph
 * API, and reports back. Every decision that needs to be consistent (is this
 * due? has it already gone out? has it run out of retries?) is made here,
 * inside the database, because n8n can run more than one execution at a time
 * and a workflow has no way to be atomic on its own.
 *
 * State machine on `deliverables.instagram_status`:
 *
 *   not_posted ──(admin schedules)──► scheduled
 *   scheduled  ──(claim, time due)──► processing
 *   processing ──(Graph API ok)─────► posted      (terminal)
 *   processing ──(Graph API fails)──► scheduled   (retry budget left)
 *                                 └─► failed      (budget exhausted, terminal)
 *
 * `posted` is never left by the automation — a published post can't be
 * unpublished by re-running a workflow.
 */
import "server-only";
import { query, queryOne, execute, transaction, hasColumn } from "./db";
import { env } from "./env";
import { resolveVideoUrl, directDownloadUrl } from "./storage";
import { notifyAdmins } from "./notify";
import {
  nowUtc,
  nextBestPostTime,
  bothClocks,
  windowHoursFor,
  postingTimeLabel,
  MAX_WINDOW_HOURS,
  autoPostKind,
} from "./posting";
import { postingSlotFor } from "./best-time";
import { groupOrderSql } from "./whatsapp-groups";

/** How many times a single deliverable may be attempted before giving up. */
export const MAX_POST_ATTEMPTS = 4;

/**
 * How long a claim is honoured. If an n8n execution dies mid-publish (node
 * restart, timeout, network partition) the row would otherwise sit in
 * `processing` for ever. After the lease expires the queue may hand it out
 * again — long enough that a slow-but-alive run is never double-claimed, short
 * enough that a dead one is recovered within the hour.
 */
export const CLAIM_LEASE_MINUTES = 20;

/**
 * How long after its slot a post may still go out on its own — at the outside.
 *
 * A post belongs to its window. Past that it is not "late", it is missed: the
 * evening it was written for has gone, and publishing it at midnight puts a
 * reel in front of nobody and leaves an odd timestamp on a client's account
 * for ever. So the publisher stops offering it, the missed-posts board picks
 * it up, and a person moves it to the next day — a decision, made by someone
 * who can see whether it is still worth posting at all.
 *
 * The window is the client's, not one number for the roster: India posts 5–7
 * PM and Australia 6–7 PM, in their own clocks. This is the widest of them,
 * and it exists because the SQL below cannot read a country out of a JSON
 * column per row. It prefilters on the widest and each row is then checked
 * against its own window in `missedItsWindow`. Over-selecting and narrowing is
 * safe; the reverse would drop a post that was still due.
 */
export const PUBLISH_WINDOW_HOURS = MAX_WINDOW_HOURS;

export type PublishQueueItem = {
  deliverable_id: number;
  client_id: number;
  client_name: string;
  title: string;
  /** Caption with hashtags already appended — what n8n sends verbatim. */
  caption: string;
  hashtags: string | null;
  /**
   * A URL Instagram's servers can fetch the bytes from. For a public R2
   * bucket this is the permanent URL; for a private one it's a signed GET
   * valid long enough for Meta to pull the file (see `resolveVideoUrl`).
   */
  video_url: string;
  media_type: "REELS" | "IMAGE";
  /** Meta Graph IG business account id. */
  ig_user_id: string;
  /**
   * The client's Facebook Page, or null.
   *
   * Set means "post there too" — one field rather than a Page id and a
   * separate switch, because a Page id on a client record has never meant
   * anything else.
   */
  fb_page_id: string | null;
  /**
   * Per-client Graph token, or null to use n8n's agency-wide META_ACCESS_TOKEN.
   * Only sent to the automation, never to a browser.
   */
  ig_access_token: string | null;
  scheduled_at: string;
  attempt_no: number;
  client_email: string | null;
  client_whatsapp: string | null;
  /**
   * Where to send the "your post is live" message, as a WhatsApp chat id.
   *
   * The client's own group when they have one — that is where every other
   * conversation about their videos already happens — otherwise their number
   * as a direct chat. Sent ready to use so the automation never has to know
   * that whatsapp-web.js wants `@g.us` for groups and `@c.us` for people.
   *
   * Null when there is no group and no usable number, which is the automation's
   * cue to skip the message rather than guess at an address.
   */
  wa_chat_id: string | null;
  contact_person: string | null;
  campaign: string | null;
};

/**
 * Instagram needs a directly fetchable URL; a signed one has to outlive the
 * whole publish (container build + Meta downloading the file + our retries).
 * Six hours is generous but costs nothing.
 */
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

/** Hashtags are stored apart from the caption; Instagram wants one string. */
/**
 * The columns that actually hand a deliverable to the publisher.
 *
 * `instagram_status` is what the queue filters on, and it is the one field
 * both scheduling paths forgot to set: the workflow status went to
 * "scheduled", `posting_status` went to "scheduled", and `instagram_status`
 * stayed at its default of `not_posted`, which the queue does not select. The
 * result was a queue that was always empty and a video that sat marked
 * scheduled for ever without posting.
 *
 * Expressed once, here, because the bug was two places disagreeing about what
 * "scheduled" means. Anything that schedules a post merges this in.
 *
 * `posted` is never walked back — a published post cannot be unpublished by
 * scheduling it again.
 */
export function publishHandoff(current: {
  instagram_status?: string | null;
  scheduled_at?: string | null;
  /** The client's record, for whose evening the post belongs to. */
  placeholder_values?: unknown;
}): Record<string, string | null> {
  if (current.instagram_status === "posted") return {};

  const out: Record<string, string | null> = {
    instagram_status: "scheduled",
    posting_status: "scheduled",
  };

  /*
   * A time is required — the queue only returns rows whose slot has arrived,
   * so a null one is never due and never posts. An existing time is always
   * left alone; the question is only what to write when there is none.
   *
   * It used to write *now*, meaning "as soon as you can". That reads fine
   * until you follow where the null comes from: sending a video for approval
   * clears `scheduled_at`, so by the time the approval lands there is never a
   * time, and every approved video was scheduled for the minute it was
   * approved. An Australian client's reel approved at a quarter to one in the
   * afternoon went out at 5:15 in the afternoon their time — not because
   * anybody chose 5:15, but because that was when somebody pressed a button
   * in Hyderabad. The whole country-and-window apparatus was being bypassed by
   * the one line that decides when a post actually goes.
   *
   * So the default is the client's next evening slot. "As soon as you can" is
   * still available and is a different button — Post now, which publishes
   * immediately rather than pretending to schedule.
   */
  if (!current.scheduled_at) {
    out.scheduled_at = nextBestPostTime(countryOf(current.placeholder_values));
  }

  return out;
}

/**
 * True when there is a finished file Meta's servers could actually fetch.
 *
 * "Is there a link on the task" is not the same question, and posters are
 * where the difference bites: a designer submits a Drive or Canva address,
 * and a Canva address is a web app. Handed to Meta as `image_url` it fetches
 * an HTML page, refuses it, and spends one of four attempts on a task that
 * can never succeed until somebody uploads the actual image.
 *
 * Drive is the exception worth making, because it is what people paste: the
 * same file has a download address, and `directDownloadUrl` rewrites the
 * share form into it. Everything else has to already *be* the file.
 */
export function hasPostableFile(row: {
  cloud_video_key?: string | null;
  cloud_video_url?: string | null;
  edited_link?: string | null;
}): boolean {
  // Ours, and a signed URL for it is made at publish time.
  if (row.cloud_video_key || row.cloud_video_url) return true;

  const link = String(row.edited_link ?? "").trim();
  if (!link) return false;
  if (/drive\.google\.com/i.test(link)) return true;
  return /\.(mp4|mov|m4v|webm|jpe?g|png|webp|gif|avif)(\?|$)/i.test(link);
}

/**
 * What an approval does to a video that is set up to post by itself.
 *
 * Returns the columns to write — `{}` when this one is not set up, which is
 * the ordinary case and not an error.
 *
 * ## Why it takes an id and reads its own row
 *
 * Three places accept an approval — the desk, the client portal, and a reply
 * in the WhatsApp group — and each had its own idea of when that approval was
 * allowed to schedule anything. The portal checked five conditions. WhatsApp
 * checked two, so a poster approved in a group, or a reel whose video had not
 * been uploaded yet, was marked `scheduled` and handed to a queue that
 * requires a video file: the board said queued, the publisher never returned
 * the row, and it sat there for ever. The desk checked none, because the desk
 * did not schedule at all — an admin pressing Approve had to press Schedule
 * afterwards, which is the manual step this removes.
 *
 * They disagreed because each one worked from whatever columns its own query
 * happened to select. So this reads the row itself. One SELECT per approval,
 * against a human pressing a button, buys the guarantee that all three ask the
 * same question.
 *
 * ## And it stays narrow
 *
 * Every condition here is one the publish queue will insist on later. Nothing
 * is inferred: unattended posting to a live account needs `auto_publish` and a
 * linked Instagram id, and approving a video is consent to publish *that
 * video*, never consent to start publishing automatically.
 */
export async function approvalHandoff(deliverableId: number): Promise<Record<string, string | null>> {
  const row = await queryOne<{
    client_id: number;
    instagram_status: string | null;
    scheduled_at: string | null;
    due_date: string | null;
    content_category: string | null;
    service: string | null;
    video_type: string | null;
    edited_link: string | null;
    cloud_video_key: string | null;
    cloud_video_url: string | null;
    auto_publish: number | null;
    ig_user_id: string | null;
    placeholder_values: unknown;
  }>(
    `SELECT d.client_id, d.instagram_status, d.scheduled_at, d.due_date, d.content_category,
            d.service, d.video_type, d.edited_link, d.cloud_video_key, d.cloud_video_url,
            c.auto_publish, c.ig_user_id, c.placeholder_values
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  ).catch(() => null);

  if (!row) return {};
  // History, not a queue entry.
  if (row.instagram_status === "posted") return {};
  // The client has to have opted in, and to have somewhere to post to.
  if (Number(row.auto_publish) !== 1 || !row.ig_user_id) return {};
  // And it has to be something that posts by itself: a reel, or a poster that
  // is a feed post rather than a thumbnail or a banner.
  if (!autoPostKind(row)) return {};
  // Finally, a finished file — and one Meta's servers can actually fetch.
  if (!hasPostableFile(row)) return {};
  /*
   * The day it is down for, at their own proven hour — see `postingSlotFor`.
   * A reel dated the 26th and approved on the 20th used to be scheduled for
   * the 20th, because the only thing consulted was the clock.
   *
   * A time somebody set by hand always wins: `publishHandoff` fills a blank
   * and never argues with a decision already made.
   */
  const picked = row.scheduled_at
    ? null
    : await postingSlotFor(
        row.client_id,
        countryOf(row.placeholder_values),
        row.due_date
      ).catch(() => null);

  const out: Record<string, string | null> = {
    status: "scheduled",
    ...publishHandoff({
      instagram_status: row.instagram_status,
      scheduled_at: row.scheduled_at ?? picked ?? null,
      placeholder_values: row.placeholder_values,
    }),
  };
  if (picked) out.scheduled_at = picked;
  return out;
}

export function composeCaption(caption: string | null, hashtags: string | null): string {
  const body = (caption || "").trim();
  const tags = (hashtags || "").trim();
  if (!tags) return body;
  if (!body) return tags;
  /*
   * Once, however many times it has been stored.
   *
   * The analysis used to write the tags into the caption as well as into
   * `hashtags`, so joining them here published the block twice. The writer
   * no longer does that — but every reel captioned before it stopped still
   * holds a body ending in its own tags, and those go out too.
   *
   * Compared on the tags alone rather than on whitespace: the two copies
   * were joined with different spacing depending on which path wrote them.
   */
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(body).endsWith(norm(tags))) return body;

  /*
   * And not at all when the caption already ends in its own block of them.
   *
   * A client with an agreed caption structure usually ends it with their
   * hashtags, and the writer is told to put them there and nowhere else. Ours
   * were appended underneath anyway — a second tag block below the client's,
   * which is the one part of the shape a client actually notices.
   *
   * Two or more in a row, so a caption that happens to end on a single tag
   * mid-sentence still gets the block it was expecting.
   */
  if (/#[^\s#]+(?:\s+#[^\s#]+)+\s*$/.test(body)) return body;

  // Blank line between copy and tags — how the caption reads in the app.
  return `${body}\n\n${tags}`;
}

/**
 * REELS for video, IMAGE for a still. Meta rejects a container whose
 * media_type doesn't match the file, so this is decided from the actual asset
 * rather than from the category label a human typed.
 */
/** Exported so the Facebook publisher classifies a file the same way. */
export function mediaTypeFor(
  url: string,
  category: string | null,
  /**
   * The task itself, when the caller has it.
   *
   * This guessed from the category name alone — `includes("post")` — which is
   * right about "Instagram Post", right about "Educational Poster" by pure
   * luck, and wrong about a "Festival Creative". A poster is a poster because
   * of the work it is, and `autoPostKind` reads that off the service tag.
   *
   * It matters more than a label: getting this wrong sends a PNG to
   * Instagram's `video_url` and to Facebook's `/videos`, and both refuse it.
   */
  task?: { service?: string | null; video_type?: string | null; content_category?: string | null }
): "REELS" | "IMAGE" {
  const kind = task ? autoPostKind(task) : null;
  if (kind) return kind;
  if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(url)) return "REELS";
  if (/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return "IMAGE";
  // No usable extension (a signed URL can hide it) — fall back to the label.
  return (category || "").toLowerCase().includes("post") ? "IMAGE" : "REELS";
}

/**
 * Everything the publisher needs to know before it can run at all. Returns a
 * reason string when the feature isn't usable yet, so the API can say why
 * instead of silently returning an empty queue.
 */
export async function publishingReadiness(): Promise<{ ready: boolean; reason?: string }> {
  if (!(await hasColumn("deliverables", "instagram_media_id"))) {
    return {
      ready: false,
      reason:
        "Publishing columns are missing. Run database/migrate.js, or apply them from Settings → Database.",
    };
  }

  /*
   * No token means no publish, and asked here so it does not cost a video.
   *
   * Without one, `publishClaimed` fails each video it is handed with
   * `permanent: true` — which is correct for a genuinely bad video and exactly
   * wrong for a missing setting. A daily run would burn the whole queue, one
   * permanent failure each, for a configuration nobody had noticed was absent.
   * Checked before anything is claimed, so an unconfigured portal reports
   * "not set up" and leaves the queue where it is.
   *
   * A per-client token still overrides it; this only covers the agency-wide
   * fallback, which is what a portal with no per-client tokens relies on.
   */
  if (!env.meta.accessToken) {
    const anyClientToken = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM clients
        WHERE ig_access_token IS NOT NULL AND ig_access_token <> ''`
    );
    if (!Number(anyClientToken?.n)) {
      return {
        ready: false,
        reason:
          "No Meta access token. Nothing can be published until META_ACCESS_TOKEN is set, " +
          "or a token is saved on the client.",
      };
    }
  }

  return { ready: true };
}

/**
 * Deliverables due to go out now.
 *
 * "Due" means: the client opted in, the row is scheduled (or is a retry whose
 * lease has expired), its scheduled time has passed, it has a video and an
 * Instagram account id, and it hasn't burned through its retry budget.
 *
 * Read-only — nothing is reserved here. The workflow calls `claimForPublish`
 * per item, which is where the race is actually settled.
 */
/**
 * A WhatsApp chat id for the "your post is live" message.
 *
 * whatsapp-web.js addresses a group as `<id>@g.us` and a person as
 * `<international digits>@c.us`. Resolved here rather than in the automation:
 * the portal is what knows the client's group, and a formatting rule expressed
 * in two places is a formatting rule that will disagree with itself.
 */
function waChatId(groupId: string | undefined, phone: string | null): string | null {
  if (groupId) return groupId.includes("@") ? groupId : `${groupId}@g.us`;

  const digits = String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;
  // A bare 10-digit number is Indian with the country code left implied.
  const full = digits.length === 10 ? `91${digits}` : digits;
  return full.length >= 11 && full.length <= 15 ? `${full}@c.us` : null;
}

export async function getPublishQueue(limit = 10): Promise<PublishQueueItem[]> {
  const { ready } = await publishingReadiness();
  if (!ready) return [];

  const rows = await query<{
    id: number;
    client_id: number;
    company_name: string;
    title: string;
    caption: string | null;
    hashtags: string | null;
    content_category: string | null;
    service: string | null;
    video_type: string | null;
    campaign: string | null;
    cloud_video_url: string | null;
    cloud_video_key: string | null;
    edited_link: string | null;
    scheduled_at: string;
    post_attempts: number;
    ig_user_id: string;
    ig_access_token: string | null;
    fb_page_id: string | null;
    placeholder_values: unknown;
    email: string | null;
    whatsapp_number: string | null;
    phone: string | null;
    contact_person: string | null;
  }>(
    `SELECT d.id, d.client_id, c.company_name, d.title, d.caption, d.hashtags,
            d.content_category, d.service, d.video_type, d.campaign,
            d.cloud_video_url, d.cloud_video_key, d.edited_link,
            d.scheduled_at, d.post_attempts,
            c.ig_user_id, c.ig_access_token, c.fb_page_id, c.placeholder_values,
            c.email, c.whatsapp_number, c.phone, c.contact_person
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned'
        AND c.auto_publish = 1
        AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''
        -- Against the app's UTC, not NOW(). scheduled_at was written by the
        -- app in UTC, and a database keeping any other wall clock would make
        -- every post due at the wrong hour. post_locked_at below is written
        -- and read by the database on both sides, so it stays on NOW().
        AND d.scheduled_at IS NOT NULL AND d.scheduled_at <= ?
        /*
         * ...and not so long ago that the slot has been and gone.
         *
         * "Due" used to mean any time at all after the scheduled minute, so a
         * reel that missed its evening — the service down, Instagram slow, the
         * runner not deployed — went out whenever the next successful run
         * happened. In practice that is the middle of the night, to an
         * audience that is asleep, on a client's account.
         *
         * A post now belongs to its window and nothing else. Miss it and it
         * stops being due: it appears on the missed-posts board, and someone
         * moves the date to the next day, which is what was being done by hand
         * anyway. Late and deliberate beats 3am and automatic.
         */
        AND d.scheduled_at > DATE_SUB(?, INTERVAL ? HOUR)
        AND d.post_attempts < ?
        -- Ready to hand out: waiting its turn, or a previous run that took the
        -- row and never came back (expired lease).
        AND (
              d.instagram_status = 'scheduled'
           OR (d.instagram_status = 'processing'
               AND d.post_locked_at IS NOT NULL
               AND d.post_locked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
        )
        AND (d.cloud_video_key IS NOT NULL
             OR (d.cloud_video_url IS NOT NULL AND d.cloud_video_url <> '')
             OR (d.edited_link IS NOT NULL AND d.edited_link <> ''))
      ORDER BY d.scheduled_at ASC, d.id ASC
      LIMIT ${Number(limit) || 10}`,
    [nowUtc(), nowUtc(), PUBLISH_WINDOW_HOURS, MAX_POST_ATTEMPTS, CLAIM_LEASE_MINUTES]
  );

  /*
   * Each client's approval group, looked up once for the whole batch rather
   * than once per row. The table arrived with the WhatsApp feature and may not
   * exist on an older install, which is not an error — it just means nobody
   * has a group and every message goes to a number instead.
   */
  const groups = new Map<number, string>();
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  if (clientIds.length && (await hasColumn("whatsapp_groups", "group_id"))) {
    const found = await query<{ client_id: number; group_id: string }>(
      `SELECT client_id, group_id FROM whatsapp_groups
        WHERE is_active = 1 AND client_id IN (${clientIds.map(() => "?").join(",")})
        ORDER BY ${await groupOrderSql("updates")}`,
      clientIds
    );
    // First row per client wins — the ORDER BY puts the default one there.
    for (const g of found) if (!groups.has(g.client_id)) groups.set(g.client_id, g.group_id);
  }

  const items = await Promise.all(
    rows.map(async (r) => {
      /*
       * Prefer our own storage: Meta must fetch real bytes, and a Drive share
       * link serves an HTML page instead. Where a pasted link is all there is,
       * `directDownloadUrl` turns the Drive form into the download form —
       * which is what makes a poster submitted as a Drive link postable at
       * all. `hasPostableFile` is what kept the ones it cannot fix out.
       */
      const videoUrl =
        (await resolveVideoUrl(r.cloud_video_key, r.cloud_video_url, SIGNED_URL_TTL_SECONDS)) ||
        directDownloadUrl(r.edited_link) ||
        "";
      if (!videoUrl) return null; // storage not configured — skip rather than fail the run

      /*
       * The SQL above kept anything inside the widest window on the roster;
       * this row only belongs in the queue if it is inside its own.
       *
       * Without it an Australian reel set for 6 PM Sydney would still be
       * handed out at 8 — inside India's two hours, an hour past the window
       * their client was told about, and dark by then where it is being read.
       */
      if (missedItsWindow(String(r.scheduled_at), countryOf(r.placeholder_values))) return null;

      return {
        deliverable_id: r.id,
        client_id: r.client_id,
        client_name: r.company_name,
        title: r.title,
        caption: composeCaption(r.caption, r.hashtags),
        hashtags: r.hashtags,
        video_url: videoUrl,
        media_type: mediaTypeFor(r.cloud_video_key || videoUrl, r.content_category, r),
        ig_user_id: r.ig_user_id,
        fb_page_id: r.fb_page_id ?? null,
        ig_access_token: r.ig_access_token || null,
        scheduled_at: r.scheduled_at,
        attempt_no: Number(r.post_attempts) + 1,
        client_email: r.email,
        // WhatsApp falls back to the contact phone — most clients have one
        // number and never fill the dedicated field.
        client_whatsapp: r.whatsapp_number || r.phone,
        wa_chat_id: waChatId(groups.get(r.client_id), r.whatsapp_number || r.phone),
        contact_person: r.contact_person,
        campaign: r.campaign,
      } satisfies PublishQueueItem;
    })
  );

  return items.filter((i): i is PublishQueueItem => i !== null);
}

export type ClaimResult =
  | { ok: true; item: PublishQueueItem }
  | { ok: false; reason: "not_found" | "already_posted" | "claimed_elsewhere" | "exhausted" };

/**
 * Reserve a deliverable for one publishing run.
 *
 * This is the concurrency guard for the whole feature. Two n8n executions
 * polling at the same moment see the same queue; the conditional UPDATE means
 * exactly one of them gets `affectedRows === 1` and the other is told to move
 * on. Without it the same reel goes to Instagram twice.
 *
 * Increments `post_attempts` on the way in, not on failure — a run that dies
 * without reporting anything has still consumed an attempt, which is what
 * stops a reliably-crashing item from being retried for ever.
 */
export async function claimForPublish(
  deliverableId: number,
  runId?: string | null
): Promise<ClaimResult> {
  return transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT instagram_status, post_attempts FROM deliverables WHERE id = ? FOR UPDATE`,
      [deliverableId]
    );
    const current = (rows as { instagram_status: string; post_attempts: number }[])[0];
    if (!current) return { ok: false, reason: "not_found" } as const;
    if (current.instagram_status === "posted") return { ok: false, reason: "already_posted" } as const;
    if (Number(current.post_attempts) >= MAX_POST_ATTEMPTS) {
      return { ok: false, reason: "exhausted" } as const;
    }

    const [res] = await conn.execute(
      `UPDATE deliverables
          SET instagram_status = 'processing',
              posting_status   = 'scheduled',
              post_locked_at   = NOW(),
              post_attempts    = post_attempts + 1,
              post_error       = NULL
        WHERE id = ?
          AND instagram_status <> 'posted'
          AND (
                instagram_status = 'scheduled'
             OR (instagram_status = 'processing'
                 AND post_locked_at IS NOT NULL
                 AND post_locked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
          )`,
      [deliverableId, CLAIM_LEASE_MINUTES]
    );
    if ((res as { affectedRows: number }).affectedRows !== 1) {
      return { ok: false, reason: "claimed_elsewhere" } as const;
    }

    const [after] = await conn.execute(
      `SELECT d.id, d.client_id, c.company_name, d.title, d.caption, d.hashtags,
              d.content_category, d.service, d.video_type, d.campaign,
              d.cloud_video_url, d.cloud_video_key, d.edited_link,
              d.scheduled_at, d.post_attempts,
              c.ig_user_id, c.ig_access_token, c.fb_page_id,
              c.email, c.whatsapp_number, c.phone, c.contact_person
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE d.id = ?`,
      [deliverableId]
    );
    const r = (after as Record<string, string | number | null>[])[0];

    /*
     * The client's approval group, on the same connection as the claim.
     *
     * This is the copy the automation actually reads — the queue is only a
     * shopping list, the claim is what gets published from — so the chat id
     * has to be resolved here too or the "your post is live" message has
     * nowhere to go.
     */
    let groupId: string | undefined;
    try {
      const [gRows] = await conn.execute(
        `SELECT group_id FROM whatsapp_groups
          WHERE client_id = ? AND is_active = 1
          ORDER BY ${await groupOrderSql("updates")} LIMIT 1`,
        [r.client_id]
      );
      groupId = (gRows as { group_id: string }[])[0]?.group_id;
    } catch {
      // Older install without the WhatsApp tables: fall through to the number.
    }

    await conn.execute(
      `INSERT INTO publish_attempts
         (deliverable_id, client_id, attempt_no, stage, status, run_id)
       VALUES (?, ?, ?, 'claimed', 'processing', ?)`,
      [deliverableId, r.client_id, r.post_attempts, runId ?? null]
    );

    // Same resolution as the queue, and it has to stay the same: this is the
    // copy that is actually published from.
    const videoUrl =
      (await resolveVideoUrl(
        r.cloud_video_key as string | null,
        r.cloud_video_url as string | null,
        SIGNED_URL_TTL_SECONDS
      )) ||
      directDownloadUrl(r.edited_link as string | null) ||
      "";

    return {
      ok: true,
      item: {
        deliverable_id: Number(r.id),
        client_id: Number(r.client_id),
        client_name: String(r.company_name),
        title: String(r.title),
        caption: composeCaption(r.caption as string | null, r.hashtags as string | null),
        hashtags: (r.hashtags as string | null) ?? null,
        video_url: videoUrl,
        media_type: mediaTypeFor((r.cloud_video_key as string | null) || videoUrl, r.content_category as string | null, {
          service: r.service as string | null,
          video_type: r.video_type as string | null,
          content_category: r.content_category as string | null,
        }),
        ig_user_id: String(r.ig_user_id ?? ""),
        fb_page_id: (r.fb_page_id as string | null) || null,
        ig_access_token: (r.ig_access_token as string | null) || null,
        scheduled_at: String(r.scheduled_at ?? ""),
        attempt_no: Number(r.post_attempts),
        client_email: (r.email as string | null) ?? null,
        client_whatsapp: ((r.whatsapp_number as string | null) || (r.phone as string | null)) ?? null,
        wa_chat_id: waChatId(
          groupId,
          ((r.whatsapp_number as string | null) || (r.phone as string | null)) ?? null
        ),
        contact_person: (r.contact_person as string | null) ?? null,
        campaign: (r.campaign as string | null) ?? null,
      },
    } as const;
  });
}

/** A step the workflow reached, logged whether or not it succeeded. */
/**
 * Hand a still-encoding video back to the queue.
 *
 * The claim exists to stop two runs publishing the same reel, and its lease is
 * twenty minutes — long enough that a run killed mid-publish doesn't strand
 * the video for ever. But a container Instagram is still encoding is not a
 * stranded video, and waiting out that lease would delay every post by twenty
 * minutes when the encode usually takes well under one.
 *
 * The attempt is given back too. Attempts are a budget for things that fail,
 * and encoding taking a moment is not a failure; counting it would exhaust the
 * budget on a video that never had a problem.
 *
 * Releasing is safe because the container id is already in the audit trail: a
 * later run — including a concurrent one — resumes that container rather than
 * creating a second, which is the thing that would actually publish twice.
 */
export async function releaseStillEncoding(deliverableId: number): Promise<void> {
  await execute(
    `UPDATE deliverables
        SET instagram_status = 'scheduled',
            post_locked_at   = NULL,
            post_attempts    = GREATEST(post_attempts - 1, 0)
      WHERE id = ? AND instagram_status = 'processing'`,
    [deliverableId]
  );
}

export async function logPublishStage(input: {
  deliverableId: number;
  clientId?: number | null;
  stage: string;
  status?: "processing" | "posted" | "failed" | "skipped";
  containerId?: string | null;
  mediaId?: string | null;
  permalink?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  runId?: string | null;
  attemptNo?: number | null;
}): Promise<void> {
  // The caller usually knows the attempt number; when it doesn't, read the
  // deliverable's counter rather than guessing, so the log lines for one run
  // all group under the same attempt.
  let attemptNo = input.attemptNo ?? null;
  let clientId = input.clientId ?? null;
  if (attemptNo == null || clientId == null) {
    const d = await queryOne<{ post_attempts: number; client_id: number }>(
      "SELECT post_attempts, client_id FROM deliverables WHERE id = ?",
      [input.deliverableId]
    );
    attemptNo = attemptNo ?? Number(d?.post_attempts ?? 1);
    clientId = clientId ?? (d ? Number(d.client_id) : null);
  }

  await execute(
    `INSERT INTO publish_attempts
       (deliverable_id, client_id, attempt_no, stage, status, container_id, media_id,
        permalink, error_code, error_message, duration_ms, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.deliverableId,
      clientId,
      attemptNo,
      input.stage,
      input.status ?? "processing",
      input.containerId ?? null,
      input.mediaId ?? null,
      input.permalink ?? null,
      input.errorCode ?? null,
      // Truncated: Meta error bodies can be long and this column is read by
      // humans in the UI, not parsed.
      input.errorMessage ? String(input.errorMessage).slice(0, 2000) : null,
      input.durationMs ?? null,
      input.runId ?? null,
    ]
  );
}

export type PostedResult = { ok: boolean; alreadyPosted?: boolean; error?: string };

/**
 * Record a successful publish. Idempotent: n8n retrying the callback after a
 * network blip must not produce a second notification or a second log line.
 */
/**
 * Fill in the post's public address, after the fact.
 *
 * Separate from `markPosted` so that recording the publish never waits on a
 * second Graph call. Scoped to the media id it belongs to, so a late reply
 * about an earlier post cannot overwrite a newer one's link.
 */
export async function setPermalink(
  deliverableId: number,
  mediaId: string,
  permalink: string
): Promise<void> {
  await execute(
    `UPDATE deliverables SET instagram_permalink = ?
      WHERE id = ? AND instagram_media_id = ?`,
    [permalink, deliverableId, mediaId]
  );
}

export async function markPosted(input: {
  deliverableId: number;
  mediaId: string;
  permalink?: string | null;
  postedAt?: string | null;
  runId?: string | null;
  durationMs?: number | null;
  /**
   * The container this media came from.
   *
   * Recorded so a later run can tell that this container has already been
   * published and must not be reused — without it the audit trail says a
   * container existed but never says it went live, and a resumed run would
   * post the same reel twice.
   */
  containerId?: string | null;
}): Promise<PostedResult> {
  const d = await queryOne<{
    id: number;
    title: string;
    client_id: number;
    instagram_status: string;
    post_attempts: number;
  }>(
    "SELECT id, title, client_id, instagram_status, post_attempts FROM deliverables WHERE id = ?",
    [input.deliverableId]
  );
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (d.instagram_status === "posted") return { ok: true, alreadyPosted: true };

  await execute(
    `UPDATE deliverables
        SET instagram_status    = 'posted',
            posting_status      = 'posted',
            status              = IF(status NOT IN ('completed'), 'posted', status),
            instagram_media_id  = ?,
            instagram_permalink = ?,
            instagram_posted_at = COALESCE(?, NOW()),
            posted_at           = COALESCE(posted_at, ?, NOW()),
            post_locked_at      = NULL,
            post_error          = NULL
      WHERE id = ?`,
    [
      input.mediaId,
      input.permalink ?? null,
      input.postedAt ?? null,
      input.postedAt ?? null,
      input.deliverableId,
    ]
  );

  await logPublishStage({
    deliverableId: d.id,
    clientId: d.client_id,
    attemptNo: d.post_attempts,
    stage: "published",
    status: "posted",
    mediaId: input.mediaId,
    containerId: input.containerId ?? null,
    permalink: input.permalink ?? null,
    durationMs: input.durationMs ?? null,
    runId: input.runId ?? null,
  });

  await execute(
    `INSERT INTO activity_logs (actor_name, action, entity_type, entity_id, description, meta_json)
     VALUES ('n8n automation', 'posted_to_instagram', 'deliverable', ?, ?, ?)`,
    [
      d.id,
      `"${d.title}" published to Instagram automatically`,
      JSON.stringify({ media_id: input.mediaId, permalink: input.permalink ?? null }),
    ]
  );

  await notifyAdmins(
    "general",
    "Posted to Instagram",
    `"${d.title}" is live on Instagram.`,
    `/deliverables/${d.id}`
  );

  return { ok: true };
}

export type FailureResult = { ok: boolean; willRetry: boolean; attemptsUsed: number; error?: string };

/**
 * Record a failed publish and decide what happens next.
 *
 * Back to `scheduled` while the retry budget holds (the next poll picks it up;
 * n8n's own wait/backoff decides how soon), and `failed` once it's spent —
 * at which point a human is told, because silence is how a client finds out
 * from the absence of a post.
 *
 * `permanent` short-circuits the budget for errors that retrying cannot fix:
 * a revoked token or a rejected media format fails identically every time.
 */
export async function markFailed(input: {
  deliverableId: number;
  errorCode?: string | null;
  errorMessage: string;
  stage?: string;
  permanent?: boolean;
  runId?: string | null;
}): Promise<FailureResult> {
  const d = await queryOne<{
    id: number;
    title: string;
    client_id: number;
    instagram_status: string;
    post_attempts: number;
  }>(
    "SELECT id, title, client_id, instagram_status, post_attempts FROM deliverables WHERE id = ?",
    [input.deliverableId]
  );
  if (!d) return { ok: false, willRetry: false, attemptsUsed: 0, error: "Deliverable not found." };
  // A late failure callback for something already live must not un-post it.
  if (d.instagram_status === "posted") {
    return { ok: true, willRetry: false, attemptsUsed: Number(d.post_attempts) };
  }

  const attemptsUsed = Number(d.post_attempts);
  const willRetry = !input.permanent && attemptsUsed < MAX_POST_ATTEMPTS;

  await execute(
    `UPDATE deliverables
        SET instagram_status = ?,
            posting_status   = IF(? = 'failed', 'not_posted', 'scheduled'),
            post_locked_at   = NULL,
            post_error       = ?
      WHERE id = ? AND instagram_status <> 'posted'`,
    [
      willRetry ? "scheduled" : "failed",
      willRetry ? "scheduled" : "failed",
      String(input.errorMessage).slice(0, 2000),
      input.deliverableId,
    ]
  );

  await logPublishStage({
    deliverableId: d.id,
    clientId: d.client_id,
    attemptNo: attemptsUsed,
    stage: input.stage || "publish",
    status: "failed",
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage,
    runId: input.runId ?? null,
  });

  if (!willRetry) {
    await notifyAdmins(
      "general",
      "Instagram post failed",
      `"${d.title}" could not be posted after ${attemptsUsed} attempt${
        attemptsUsed === 1 ? "" : "s"
      }: ${String(input.errorMessage).slice(0, 200)}`,
      `/deliverables/${d.id}`,
      // Mailed, unlike the rest. A reel that has used every retry is not going
      // out at all, on a client's account, on a day they were told it would —
      // and nobody finds that by opening the portal, because the reason to
      // open the portal was that it had gone out.
      true
    );
  }

  return { ok: true, willRetry, attemptsUsed };
}

/**
 * Put a deliverable back in the queue — the "try again" button.
 *
 * Clearing `post_attempts` is half the point: without it the row is refused
 * by the budget check the moment it is picked up.
 *
 * The other half is the time. A task with no `scheduled_at` is never due, so
 * queueing it did nothing at all — and the screen said so, in green, next to
 * the button that had just done it: *"Queued — but fix the points above or the
 * publisher will still skip it."* A button that knowingly performs a no-op and
 * then explains the no-op is worse than no button; the person pressing it has
 * told us exactly what they want.
 *
 * So it picks the slot, the same way approval does — `postingSlotFor` puts it
 * on the day the task is down for, at the hour that works for that client's
 * country, and rolls to the next day when that hour has already gone. It is
 * not a guess: it is the same rule the rest of the pipeline schedules by.
 *
 * A time that is already set is left alone. Somebody chose it, and quietly
 * moving a client's post because a button was pressed twice would be worse
 * than anything this fixes.
 */
export async function retryPublish(deliverableId: number): Promise<boolean> {
  const row = await queryOne<{
    client_id: number;
    scheduled_at: string | null;
    due_date: string | null;
    placeholder_values: unknown;
  }>(
    `SELECT d.client_id, d.scheduled_at, d.due_date, c.placeholder_values
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  ).catch(() => null);

  /*
   * Best-effort, and it must stay that way: if the slot cannot be worked out,
   * the row still goes back in the queue with its attempts cleared, which is
   * what this button did before and is never worse than refusing.
   */
  const picked =
    row && !row.scheduled_at
      ? await postingSlotFor(row.client_id, countryOf(row.placeholder_values), row.due_date).catch(
          () => null
        )
      : null;

  const res = await execute(
    `UPDATE deliverables
        SET instagram_status = 'scheduled',
            posting_status   = 'scheduled',
            post_attempts    = 0,
            post_error       = NULL,
            post_locked_at   = NULL${picked ? ", scheduled_at = ?" : ""}
      WHERE id = ? AND instagram_status <> 'posted'`,
    picked ? [picked, deliverableId] : [deliverableId]
  );
  return res.affectedRows > 0;
}

/* ------------------------ Resolving what was pasted ------------------------ */

export type ResolvedAccount = {
  igUserId: string;
  username: string | null;
  /** True when the value pasted was a Facebook Page id that we translated. */
  correctedFromPageId: boolean;
};

/**
 * Work out the real Instagram Business account id from whatever was pasted.
 *
 * People paste the Facebook **Page** id here constantly — it's the number
 * Meta's own UI shows most prominently, and the two are indistinguishable by
 * eye. Stored unchanged it breaks publishing with `(#100) Tried accessing
 * nonexisting field (media)`, which names neither the problem nor the fix,
 * and which nobody notices until a post silently doesn't go out.
 *
 * So rather than validate and reject, this translates: if the id turns out to
 * be a Page, follow `instagram_business_account` to the account actually
 * wanted.
 */
export async function resolveInstagramAccount(
  pastedId: string,
  token: string
): Promise<{ ok: true; account: ResolvedAccount } | { ok: false; error: string }> {
  const id = pastedId.trim();
  if (!/^\d{5,}$/.test(id)) {
    return { ok: false, error: "That doesn't look like a Meta account id — it should be all digits." };
  }

  const call = async <T>(path: string): Promise<T & { error?: { message?: string; code?: number } }> => {
    const url = `https://graph.facebook.com/${env.meta.apiVersion}${path}${
      path.includes("?") ? "&" : "?"
    }access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: "no-store" });
    return (await res.json()) as T & { error?: { message?: string; code?: number } };
  };

  // Try it as an Instagram account first: the common case, and one call.
  const asIg = await call<{ id?: string; username?: string }>(`/${id}?fields=username`);
  if (!asIg.error && asIg.username) {
    return {
      ok: true,
      account: { igUserId: asIg.id || id, username: asIg.username, correctedFromPageId: false },
    };
  }

  // No `username` means it isn't an IG account. See if it's a Page with one.
  const asPage = await call<{
    name?: string;
    instagram_business_account?: { id: string; username?: string };
  }>(`/${id}?fields=name,instagram_business_account{id,username}`);

  if (!asPage.error && asPage.instagram_business_account) {
    const ig = asPage.instagram_business_account;
    return {
      ok: true,
      account: { igUserId: ig.id, username: ig.username ?? null, correctedFromPageId: true },
    };
  }

  if (!asPage.error) {
    return {
      ok: false,
      error: `"${asPage.name || id}" is a Facebook Page with no Instagram Business account linked.`,
    };
  }

  return {
    ok: false,
    error:
      asIg.error?.code === 190
        ? "The Meta access token has expired or been revoked."
        : `Couldn't read that account: ${asPage.error?.message || "unknown error"}`,
  };
}

export type DeliverablePublishInfo = {
  instagramStatus: string;
  mediaId: string | null;
  permalink: string | null;
  postedAt: string | null;
  scheduledAt: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  autoPublishEnabled: boolean;
  hasInstagramAccount: boolean;
  /**
   * The Facebook half of the same publish.
   *
   * `null` where the client has no Page — not attempted is not a failure, and
   * a permanent "not posted to Facebook" on a client who does not use it is
   * the kind of red that teaches people to ignore red.
   */
  facebook: { status: string; postId: string | null; error: string | null } | null;
  /** Every condition the publish queue would fail this video on, in plain words. */
  blockers: string[];
  /** What happens next when nothing is blocking it. */
  nextLook: string | null;
};

/**
 * True once a post's slot is far enough past that the publisher has let it go.
 *
 * Measured in the client's window, not one number for everybody. India posts
 * 5–7 PM and Australia 6–7 PM local, so "an hour late" ends the Australian
 * window and is still inside the Indian one. Judging both by the widest would
 * put a Sydney reel out at 9 PM their time; by the narrowest, it would drop an
 * Indian post that was still perfectly due.
 */
export function missedItsWindow(
  scheduledAt: string,
  country: string | null | undefined
): boolean {
  const due = Date.parse(`${scheduledAt.replace(" ", "T")}Z`);
  if (Number.isNaN(due)) return false;
  return Date.now() - due > windowHoursFor(country) * 3_600_000;
}

/**
 * The client's country, out of the JSON blob it is stored in.
 *
 * Same field the caption studio localises from, so a client set up once is
 * right in both places rather than being told twice where they are.
 */
export function countryOf(placeholderValues: unknown): string | null {
  const ph =
    placeholderValues && typeof placeholderValues === "object"
      ? (placeholderValues as Record<string, unknown>)
      : {};
  return typeof ph.country === "string" && ph.country.trim() ? ph.country.trim() : null;
}


/**
 * Publishing state for one deliverable, for the panel on the task page.
 *
 * Returns null rather than throwing when the migration hasn't run — the task
 * page has to keep working on a database that predates this feature, so the
 * caller simply renders nothing.
 */
export async function getPublishInfo(
  deliverableId: number
): Promise<DeliverablePublishInfo | null> {
  if (!(await hasColumn("deliverables", "instagram_media_id"))) return null;

  const cloud = (await hasColumn("deliverables", "cloud_video_key"))
    ? "d.cloud_video_key"
    : "NULL AS cloud_video_key";

  // The post id and the reason arrive with a later migration; the status has
  // been there from the start. Read what exists, so a database part-way
  // through still shows posted-or-failed rather than throwing.
  const [hasFbId, hasFbErr] = await Promise.all([
    hasColumn("deliverables", "facebook_post_id"),
    hasColumn("deliverables", "facebook_error"),
  ]);
  const fbCols = [
    "d.facebook_status",
    hasFbId ? "d.facebook_post_id" : "NULL AS facebook_post_id",
    hasFbErr ? "d.facebook_error" : "NULL AS facebook_error",
  ].join(", ");

  const row = await queryOne<{
    instagram_status: string;
    instagram_media_id: string | null;
    instagram_permalink: string | null;
    instagram_posted_at: string | null;
    posted_at: string | null;
    scheduled_at: string | null;
    post_attempts: number;
    post_error: string | null;
    auto_publish: number | null;
    ig_user_id: string | null;
    fb_page_id: string | null;
    placeholder_values: unknown;
    facebook_status: string | null;
    facebook_post_id: string | null;
    facebook_error: string | null;
    content_category: string | null;
    edited_link: string | null;
    cloud_video_key: string | null;
    client_status: string;
  }>(
    `SELECT d.instagram_status, d.instagram_media_id, d.instagram_permalink,
            d.instagram_posted_at, d.posted_at, d.scheduled_at,
            d.post_attempts, d.post_error, d.content_category, d.edited_link,
            ${cloud}, c.auto_publish, c.ig_user_id, c.fb_page_id, c.placeholder_values,
            c.status AS client_status,
            ${fbCols}
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  );
  if (!row) return null;

  const status = row.instagram_status || "not_posted";
  const attempts = Number(row.post_attempts ?? 0);
  // Every time on this panel is in the client's clock first and ours second,
  // and the window it is judged against is theirs too.
  const country = countryOf(row.placeholder_values);

  /*
   * Why the publisher would pass this video over.
   *
   * Every one of these is a condition in `getPublishQueue`, restated as
   * something a person can act on. The queue simply returns fewer rows when
   * they fail — no error, no log line, nothing on any screen — so a video that
   * never posts looks identical to one that is merely waiting its turn. This
   * is the only place the two can be told apart.
   *
   * Deliberately checked in the order someone would fix them: the client's
   * settings first, then the task's own.
   */
  const blockers: string[] = [];
  if (status !== "posted") {
    if (row.client_status === "churned") {
      blockers.push("This client is archived, so nothing of theirs is published.");
    }
    if (!row.ig_user_id) {
      blockers.push(
        "No Instagram account is linked to this client. Add the Instagram Business account id on the client's edit page."
      );
    }
    if (Number(row.auto_publish) !== 1) {
      blockers.push(
        "Auto-publishing is off for this client. Tick it on the client's edit page, or post this one by hand."
      );
    }
    if (!row.edited_link && !row.cloud_video_key) {
      blockers.push("There is no finished video on this task yet — upload it, or paste the edited link.");
    }
    if (!autoPostKind(row)) {
      blockers.push(
        "This is not something that posts by itself. Reels and posters do; " +
          `${row.content_category ? `"${row.content_category}"` : "an uncategorised task"} does not.`
      );
    }
    if (!row.scheduled_at) {
      blockers.push("No posting time is set, so it is never due. Approve it, or press Schedule.");
    } else if (missedItsWindow(row.scheduled_at, country)) {
      const hours = windowHoursFor(country);
      blockers.push(
        `Its window (${postingTimeLabel(country)}) closed more than ${hours} hour` +
          `${hours === 1 ? "" : "s"} ago, so it won't go out on its own — a reel posted in the ` +
          `middle of the night reaches nobody. Move the date to the next day, or use Post now.`
      );
    }
    if (attempts >= MAX_POST_ATTEMPTS || status === "failed") {
      blockers.push(
        `It has used all ${MAX_POST_ATTEMPTS} attempts, so the publisher has stopped trying. Use the button below to reset it.`
      );
    }
  }

  /*
   * What happens next when nothing is blocking it.
   *
   * "Waiting for its slot" on its own leaves the obvious question unanswered,
   * and the honest answer includes the poll interval — the post does not go
   * out at exactly the minute set, it goes out at the first check after it.
   */
  let nextLook: string | null = null;
  if (status !== "posted" && blockers.length === 0 && row.scheduled_at) {
    const dueMs = Date.parse(`${String(row.scheduled_at).replace(" ", "T")}Z`);
    nextLook = Number.isNaN(dueMs)
      ? null
      : dueMs > Date.now()
        ? "the publisher posts it at the first check after that"
        : "due now — the publisher checks every 15 minutes";
  }

  return {
    instagramStatus: status,
    mediaId: row.instagram_media_id,
    permalink: row.instagram_permalink,
    postedAt: bothClocks(row.instagram_posted_at || row.posted_at, country),
    // In the client's own clock, not the UTC it is stored in. Printed raw, a
    // reel set for 6pm read "12:30:00" on the page — the right instant, shown
    // as the wrong time, on the panel someone opens to ask when it posts.
    scheduledAt: bothClocks(row.scheduled_at, country),
    attempts,
    maxAttempts: MAX_POST_ATTEMPTS,
    error: row.post_error,
    autoPublishEnabled: Boolean(row.auto_publish),
    hasInstagramAccount: Boolean(row.ig_user_id),
    // Null when they do not post to a Page at all — see the type.
    facebook: row.fb_page_id
      ? {
          status: row.facebook_status || "not_posted",
          postId: row.facebook_post_id,
          error: row.facebook_error,
        }
      : null,
    blockers,
    nextLook,
  };
}

export type PublishLogRow = {
  id: number;
  deliverable_id: number;
  title: string;
  company_name: string;
  attempt_no: number;
  stage: string;
  status: string;
  media_id: string | null;
  permalink: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

/** Recent publishing activity, for the automation log in the UI. */
export async function getPublishLog(limit = 50, clientId?: number): Promise<PublishLogRow[]> {
  if (!(await hasColumn("deliverables", "instagram_media_id"))) return [];
  const scope = clientId ? "WHERE pa.client_id = ?" : "";
  return query<PublishLogRow>(
    `SELECT pa.id, pa.deliverable_id, d.title, c.company_name, pa.attempt_no, pa.stage,
            pa.status, pa.media_id, pa.permalink, pa.error_code, pa.error_message, pa.created_at
       FROM publish_attempts pa
       LEFT JOIN deliverables d ON d.id = pa.deliverable_id
       LEFT JOIN clients c ON c.id = pa.client_id
       ${scope}
      ORDER BY pa.id DESC
      LIMIT ${Number(limit) || 50}`,
    clientId ? [clientId] : []
  );
}

/* ----------------------- Why nothing is going out ----------------------- */

export type PublishBlocker = {
  /** Short, stable key — for grouping and for a test to hold on to. */
  key:
    | "no_time"
    | "window_closed"
    | "auto_publish_off"
    | "no_instagram_account"
    | "no_file"
    | "attempts_used"
    | "not_auto_kind";
  /** What is wrong, in the words somebody would use about it. */
  reason: string;
  /** What to do about it. */
  fix: string;
  count: number;
  /** A few examples, so it can be acted on rather than only counted. */
  examples: { id: number; title: string; company: string }[];
};

/**
 * Approved work that the publisher will not pick up, and why.
 *
 * This is the answer to "the automation isn't working", and until now the
 * portal had no way to give it. Eight conditions decide whether a task enters
 * `getPublishQueue`, and a task that fails any of them is simply *not
 * returned* — no error, no log line, nothing on any screen. The run reports
 * "considered: 0" and looks perfectly healthy, because from its point of view
 * it is: there was nothing to do.
 *
 * `publishStatusFor` already restates those conditions for one task, on that
 * task's own page. That only helps somebody who already suspects that task.
 * This asks the same question across everything at once, which is what a
 * person actually has: a feeling that posts are not going out.
 *
 * Ordered by the count, so the thing wrong with the most work comes first.
 */
export async function publishBlockers(): Promise<PublishBlocker[]> {
  const cloudKey = (await hasColumn("deliverables", "cloud_video_key"))
    ? "d.cloud_video_key"
    : "NULL";
  const cloudUrl = (await hasColumn("deliverables", "cloud_video_url"))
    ? "d.cloud_video_url"
    : "NULL";

  /*
   * Everything that has been approved and has not gone out. Deliberately wider
   * than the queue: the whole point is to find the rows the queue drops.
   */
  const rows = await query<{
    id: number;
    title: string;
    company: string;
    scheduled_at: string | null;
    post_attempts: number;
    auto_publish: number | null;
    ig_user_id: string | null;
    content_category: string | null;
    service: string | null;
    video_type: string | null;
    edited_link: string | null;
    ckey: string | null;
    curl: string | null;
    placeholder_values: unknown;
  }>(
    `SELECT d.id, d.title, c.company_name AS company, d.scheduled_at, d.post_attempts,
            c.auto_publish, c.ig_user_id, d.content_category, d.service, d.video_type,
            d.edited_link, ${cloudKey} AS ckey, ${cloudUrl} AS curl, c.placeholder_values
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned'
        AND d.instagram_status IN ('scheduled', 'not_posted', 'failed')
        AND d.status IN ('approved', 'scheduled', 'caption_ready', 'completed')
      ORDER BY d.due_date DESC
      LIMIT 300`
  ).catch(() => []);

  const found = new Map<PublishBlocker["key"], PublishBlocker>();
  const note = (
    key: PublishBlocker["key"],
    reason: string,
    fix: string,
    row: { id: number; title: string; company: string }
  ) => {
    const at = found.get(key) ?? { key, reason, fix, count: 0, examples: [] };
    at.count++;
    if (at.examples.length < 3) {
      at.examples.push({ id: row.id, title: row.title, company: row.company });
    }
    found.set(key, at);
  };

  for (const r of rows) {
    /*
     * One reason per task, the first that applies, in the order somebody would
     * fix them. A task with no video *and* no posting time is really one
     * problem — "it isn't finished" — and counting it twice would make the
     * list add up to more work than exists.
     */
    if (!autoPostKind(r)) {
      note(
        "not_auto_kind",
        "Not something that posts by itself",
        "Reels and posters publish automatically. Anything else is posted by hand — this is " +
          "not a fault.",
        r
      );
      continue;
    }
    if (Number(r.auto_publish) !== 1) {
      note(
        "auto_publish_off",
        "Auto-publishing is off for the client",
        "Tick “Publish approved Reels automatically” on the client's edit page.",
        r
      );
      continue;
    }
    if (!r.ig_user_id) {
      note(
        "no_instagram_account",
        "No Instagram account on the client",
        "Add the Instagram Business account id on the client's edit page.",
        r
      );
      continue;
    }
    if (!r.edited_link && !r.ckey && !r.curl) {
      note("no_file", "No finished file on the task", "Upload the video, or paste the edited link.", r);
      continue;
    }
    if (Number(r.post_attempts) >= MAX_POST_ATTEMPTS) {
      note(
        "attempts_used",
        "Every attempt used up",
        "Open the task and press “Try again at its slot” — that clears the count.",
        r
      );
      continue;
    }
    if (!r.scheduled_at) {
      note(
        "no_time",
        "No posting time set",
        "Open the task and press “Put it in the queue” — it will choose the slot.",
        r
      );
      continue;
    }
    if (missedItsWindow(String(r.scheduled_at), countryOf(r.placeholder_values))) {
      note(
        "window_closed",
        "Its posting window has closed",
        "Move the date to the next day, or use “Post now”. A reel posted in the middle of the " +
          "night reaches nobody, so the publisher deliberately stops rather than catching up.",
        r
      );
      continue;
    }
  }

  return [...found.values()].sort((a, b) => b.count - a.count);
}
