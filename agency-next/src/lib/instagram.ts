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
import { resolveVideoUrl } from "./storage";
import { notifyAdmins } from "./notify";
import {
  nowUtc,
  nextBestPostTime,
  AUTO_SCHEDULE_CATEGORIES,
  bothClocks,
  windowHoursFor,
  postingTimeLabel,
  MAX_WINDOW_HOURS,
} from "./posting";

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

/** Content categories eligible for unattended posting. */
export const AUTO_POST_CATEGORIES = ["Instagram Reel", "Instagram Post"];

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

export function composeCaption(caption: string | null, hashtags: string | null): string {
  const body = (caption || "").trim();
  const tags = (hashtags || "").trim();
  if (!tags) return body;
  if (!body) return tags;
  // Blank line between copy and tags — how the caption reads in the app.
  return `${body}\n\n${tags}`;
}

/**
 * REELS for video, IMAGE for a still. Meta rejects a container whose
 * media_type doesn't match the file, so this is decided from the actual asset
 * rather than from the category label a human typed.
 */
/** Exported so the Facebook publisher classifies a file the same way. */
export function mediaTypeFor(url: string, category: string | null): "REELS" | "IMAGE" {
  if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(url)) return "REELS";
  if (/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return "IMAGE";
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
            d.content_category, d.campaign,
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
        ORDER BY is_default DESC, id ASC`,
      clientIds
    );
    // First row per client wins — the ORDER BY puts the default one there.
    for (const g of found) if (!groups.has(g.client_id)) groups.set(g.client_id, g.group_id);
  }

  const items = await Promise.all(
    rows.map(async (r) => {
      // Prefer our own storage: Instagram must fetch real bytes, and a Drive
      // share link serves an HTML page instead.
      const videoUrl =
        (await resolveVideoUrl(r.cloud_video_key, r.cloud_video_url, SIGNED_URL_TTL_SECONDS)) ||
        r.edited_link ||
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
        media_type: mediaTypeFor(r.cloud_video_key || videoUrl, r.content_category),
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
              d.content_category, d.campaign,
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
          ORDER BY is_default DESC, id ASC LIMIT 1`,
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

    const videoUrl =
      (await resolveVideoUrl(
        r.cloud_video_key as string | null,
        r.cloud_video_url as string | null,
        SIGNED_URL_TTL_SECONDS
      )) ||
      (r.edited_link as string | null) ||
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
        media_type: mediaTypeFor(
          (r.cloud_video_key as string | null) || videoUrl,
          r.content_category as string | null
        ),
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
 * Put a failed deliverable back in the queue — the "try again" button.
 * Clearing `post_attempts` is the point: without it the row is refused by the
 * budget check the moment it's picked up.
 */
export async function retryPublish(deliverableId: number): Promise<boolean> {
  const res = await execute(
    `UPDATE deliverables
        SET instagram_status = 'scheduled',
            posting_status   = 'scheduled',
            post_attempts    = 0,
            post_error       = NULL,
            post_locked_at   = NULL
      WHERE id = ? AND instagram_status <> 'posted'`,
    [deliverableId]
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
function missedItsWindow(scheduledAt: string, country: string | null | undefined): boolean {
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
    if (row.content_category !== AUTO_SCHEDULE_CATEGORIES[0]) {
      blockers.push(
        `Only "${AUTO_SCHEDULE_CATEGORIES[0]}" posts automatically. This one is ` +
          `${row.content_category ? `"${row.content_category}"` : "not categorised"}.`
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
