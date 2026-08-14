/**
 * The same post, on the client's Facebook Page.
 *
 * A reel and a Page video are the same file with the same caption, and Meta
 * Business Suite exists because nobody wants to post them twice. The portal
 * was doing the Instagram half and stopping — `deliverables.facebook_status`
 * has been in the schema since the beginning with nothing ever writing to it.
 *
 * **Why this is not a second queue.** Instagram publishing already owns the
 * hard parts: when to post, the claim that stops two runs doing it twice, the
 * retry budget, the audit trail. Facebook is one more HTTP call once that has
 * succeeded, against a file Meta is already holding a URL for — so it rides
 * along at the end of the same run rather than being scheduled separately.
 * Two schedulers for one post is two places for the same state to be wrong.
 *
 * **And it can never fail the Instagram post.** By the time this runs the reel
 * is live on the client's feed and the row says so. A Page that refuses the
 * video is a thing to record and show, not a reason to mark a published post
 * as failed and have a retry publish it to Instagram a second time.
 */
import "server-only";
import { execute, hasColumn, queryOne } from "./db";
import { env } from "./env";
import { resolveVideoUrl } from "./storage";
import { composeCaption, mediaTypeFor } from "./instagram";

const GRAPH = "https://graph.facebook.com";

export type FacebookOutcome =
  | { ok: true; postId: string }
  /** Nothing was attempted — no Page configured. Not a failure. */
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; error: string };

type Input = {
  deliverableId: number;
  /** The Page to post to. Absent for a client who has not set one. */
  pageId: string | null;
  /**
   * The Page access token. In practice the same one Instagram publishing
   * uses: an IG business account is reached through the Page it is linked to,
   * so the token the portal already stores is a Page token.
   *
   * It needs `pages_manage_posts` on top of the Instagram scopes, which a
   * token generated only for publishing to Instagram will not have — hence
   * the plain-English error below rather than Meta's own wording.
   */
  token: string | null;
  /** A URL Meta's servers can fetch, exactly as Instagram was handed. */
  mediaUrl: string;
  mediaType: "REELS" | "IMAGE";
  caption: string;
};

/**
 * Post to the Page, and record the outcome either way.
 *
 * `/{page-id}/videos` with `file_url` is deliberately chosen over the Reels
 * API. Both put a video on the Page; this one hands Meta a URL and lets it
 * fetch the bytes, which is the one shape a serverless function can do — the
 * Reels endpoint is a three-phase resumable upload of the file itself, which
 * is the same reason YouTube had to move to n8n.
 */
export async function publishToPage(input: Input): Promise<FacebookOutcome> {
  const { deliverableId, pageId, token, mediaUrl, mediaType, caption } = input;

  if (!pageId) {
    return { ok: false, skipped: true, reason: "This client has no Facebook Page id." };
  }
  if (!token) {
    await record(deliverableId, "failed", null, "No Meta access token configured.");
    return { ok: false, error: "No Meta access token configured." };
  }

  const v = env.meta.apiVersion;
  // A photo takes `url` + `caption`; a video takes `file_url` + `description`.
  // Same two facts, different spelling, and getting it the wrong way round
  // fails with a message about a missing parameter rather than the real cause.
  const path = mediaType === "IMAGE" ? "photos" : "videos";
  const body = new URLSearchParams(
    mediaType === "IMAGE"
      ? { url: mediaUrl, caption, access_token: token }
      : { file_url: mediaUrl, description: caption, access_token: token }
  );

  try {
    const res = await fetch(`${GRAPH}/${v}/${pageId}/${path}`, {
      method: "POST",
      body,
      // Meta fetches the file itself, but it does that fetch before answering.
      // A long video makes this a slow call rather than a fast one.
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      post_id?: string;
      error?: { message?: string; code?: number; error_subcode?: number };
    };

    const postId = json.post_id || json.id;
    if (!res.ok || json.error || !postId) {
      const message = explain(json.error?.message, json.error?.code);
      await record(deliverableId, "failed", null, message);
      return { ok: false, error: message };
    }

    await record(deliverableId, "posted", postId, null);
    return { ok: true, postId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Facebook did not answer.";
    await record(deliverableId, "failed", null, message);
    return { ok: false, error: message };
  }
}

/**
 * Meta's message, plus the sentence that says what to do about it.
 *
 * The permissions case is worth naming outright: a token generated to publish
 * to Instagram carries the Instagram scopes and not `pages_manage_posts`, so
 * the first thing anybody sees on switching this on is a permissions error
 * about a token that visibly works for Instagram. Left in Meta's words that
 * reads as a bug in the portal.
 */
function explain(message: string | undefined, code: number | undefined): string {
  const base = message || "Facebook refused the post.";
  if (code === 200 || code === 10 || /permission/i.test(base)) {
    return `${base} — the token needs the pages_manage_posts permission, which a token made only for Instagram publishing does not have.`;
  }
  if (code === 190) {
    return `${base} — the access token is expired or invalid. Generate a new Page token in Meta Business Settings.`;
  }
  if (code === 100 || code === 803) {
    return `${base} — check the Page id on the client. It is the Page's own id, not the Instagram account id.`;
  }
  return base;
}

/**
 * Write what happened, on the columns that are there.
 *
 * `facebook_status` has been in the schema from the start. The id and the
 * error are new, so both are gated — a database that has not run the
 * migration still records posted-or-failed and simply does not keep the
 * detail, which is better than a publish that throws on an UPDATE.
 */
async function record(
  deliverableId: number,
  status: "posted" | "failed",
  postId: string | null,
  error: string | null
): Promise<void> {
  try {
    const [hasId, hasError] = await Promise.all([
      hasColumn("deliverables", "facebook_post_id"),
      hasColumn("deliverables", "facebook_error"),
    ]);
    const sets = ["facebook_status = ?"];
    const params: (string | null)[] = [status];
    if (hasId) {
      sets.push("facebook_post_id = ?");
      params.push(postId);
    }
    if (hasError) {
      sets.push("facebook_error = ?");
      params.push(error);
    }
    await execute(`UPDATE deliverables SET ${sets.join(", ")} WHERE id = ?`, [
      ...params,
      deliverableId,
    ]);
  } catch (err) {
    // The post is on the Page either way. Losing the note about it is not a
    // reason to throw into a publish run that has already succeeded.
    console.warn("[facebook] could not record the outcome:", err instanceof Error ? err.message : err);
  }
}

/** The public address of a Page post, for the task page to link to. */
export function facebookPermalink(postId: string | null): string | null {
  if (!postId) return null;
  // Meta returns either "<pageId>_<postId>" or a bare id depending on the
  // endpoint; both resolve from the same path.
  return `https://www.facebook.com/${postId.replace("_", "/posts/")}`;
}

/**
 * Put one video on the Page on its own, outside a publish run.
 *
 * Two moments need this and neither is covered by the Instagram retry, which
 * refuses to touch anything already posted — correctly, since re-running it
 * would publish the reel to Instagram twice:
 *
 *   - the Page refused it. The commonest reason is a token without
 *     `pages_manage_posts`, which is fixed in Meta and then wants one button
 *     rather than a re-post to Instagram nobody asked for.
 *   - the Page id was added afterwards. The reel went out last week, the
 *     client asked for Facebook too, and there is nothing to schedule because
 *     the Instagram half is done.
 *
 * Resolves the media URL again rather than reusing a stored one: a signed R2
 * link is good for hours, and both of these happen days later.
 */
export async function publishToPageNow(
  deliverableId: number
): Promise<FacebookOutcome> {
  const row = await queryOne<{
    id: number;
    caption: string | null;
    hashtags: string | null;
    content_category: string | null;
    cloud_video_url: string | null;
    cloud_video_key: string | null;
    edited_link: string | null;
    facebook_status: string | null;
    fb_page_id: string | null;
    ig_access_token: string | null;
  }>(
    `SELECT d.id, d.caption, d.hashtags, d.content_category,
            d.cloud_video_url, d.cloud_video_key, d.edited_link,
            d.facebook_status, c.fb_page_id, c.ig_access_token
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  );
  if (!row) return { ok: false, error: "Task not found." };
  if (!row.fb_page_id) {
    return {
      ok: false,
      skipped: true,
      reason: "This client has no Facebook Page id. Add it on their edit page.",
    };
  }
  // The one thing this must not do is post the same video to the Page twice.
  if (row.facebook_status === "posted") {
    return { ok: false, skipped: true, reason: "This is already on the Page." };
  }

  const mediaUrl =
    (await resolveVideoUrl(row.cloud_video_key, row.cloud_video_url, 6 * 60 * 60)) ||
    row.edited_link;
  if (!mediaUrl) {
    return { ok: false, error: "There is no finished video on this task to post." };
  }

  return publishToPage({
    deliverableId,
    pageId: row.fb_page_id,
    token: row.ig_access_token || env.meta.accessToken,
    mediaUrl,
    // The same rule the Instagram queue uses, so a poster does not get sent to
    // the video endpoint because it was posted from a different button.
    mediaType: mediaTypeFor(row.cloud_video_key || mediaUrl, row.content_category),
    caption: composeCaption(row.caption, row.hashtags),
  });
}
