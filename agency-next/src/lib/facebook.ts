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
export function explain(message: string | undefined, code: number | undefined): string {
  const base = message || "Facebook refused the post.";

  /*
   * Order matters, and it is not the obvious one.
   *
   * Meta's message for a Page id that does not exist is "... does not exist,
   * cannot be loaded due to missing permissions, or does not support this
   * operation" — it lists every possible cause including permissions, so a
   * `/permission/i` test matches it and a plain typo in the Page id got
   * "the token needs pages_manage_posts". Measured, not guessed: asking for
   * Page 99999999999999 with a working token produced exactly that.
   *
   * So the shapes that name themselves are matched first, and the permission
   * catch-all only gets what is left.
   */
  if (/does not exist|Unsupported get request/i.test(base)) {
    return `${base} — check the Page id. It is the Facebook Page's own id, not the Instagram account id.`;
  }
  if (code === 190) {
    return `${base} — the access token is expired or invalid. Generate a new Page token in Meta Business Settings.`;
  }
  /*
   * Code 10 on a Page that plainly exists is the wrong-Page token: a Page
   * token reads its *own* Page freely and needs a reviewed permission to read
   * anyone else's, so this is what a token generated in Graph API Explorer
   * with the wrong Page selected looks like. Verified against a real token
   * pointed at a Page it does not administer.
   */
  if (code === 10) {
    return `${base} — this token cannot act on that Page. It was most likely generated with a different Page selected; regenerate it with the right Page.`;
  }
  if (code === 200 || /permission/i.test(base)) {
    return `${base} — the token needs the pages_manage_posts permission, which a token made only for Instagram publishing does not have.`;
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

export type PageConnection =
  /**
   * Meta answered for this Page with this token, and the token administers it.
   * There is no "connected but cannot post" — a token that does not administer
   * the Page fails the roles check below and is reported as broken, with the
   * reason. A field that is true on every path it can be read on is not a
   * signal.
   */
  | { state: "connected"; pageName: string }
  /** No Page id on the client. Nothing is wrong; Facebook is simply off. */
  | { state: "off" }
  | { state: "broken"; reason: string };

/**
 * Whether this client's Facebook is actually connected — asked, not assumed.
 *
 * The Instagram row beside this one goes green on `ig_user_id` being non-empty,
 * which is a check that somebody typed a number. That is the exact shape of
 * the bug this codebase already carries a warning about: a Facebook Page id
 * pasted into the Instagram field looks completely correct and silently never
 * publishes. A green badge earned that way is worse than no badge, because it
 * answers the question wrongly instead of leaving it open.
 *
 * So this spends one Graph call: if Meta returns the Page's name for this
 * token, the id is right, the token is valid, and it reaches that Page —
 * which is the whole of what "connected" means here.
 *
 * `tasks` used to ride along on that same call to say what the token holder
 * is allowed to do with the Page. Meta has since pulled it from a direct
 * node fetch — confirmed live: it fails with the same "(#100) nonexisting
 * field (tasks)" error even for a token that genuinely administers the Page
 * being asked about, on every API version from v12 through v22. So it is no
 * longer a signal this call can read.
 *
 * `/{page-id}/roles` fills the same gap and was checked the same way: it
 * returns successfully (even an empty list) for a token that administers
 * the Page, and a distinct `(#200) ... insufficient administrative
 * permission` for a token that is valid but belongs to a *different* Page —
 * which is exactly the failure mode the `tasks` check existed to catch (a
 * token copied for the wrong Page in Graph API Explorer reads that Page's
 * public name just fine, so the name-only call alone would have called it
 * connected). A bad Page id gives a third, distinguishable error instead
 * (code 100, missing-object), so `explain()` still gets the right message.
 */
export async function checkPageConnection(clientId: number): Promise<PageConnection> {
  const row = await queryOne<{ fb_page_id: string | null; ig_access_token: string | null }>(
    "SELECT fb_page_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  const pageId = row?.fb_page_id?.trim();
  if (!pageId) return { state: "off" };

  const token = row?.ig_access_token || env.meta.accessToken;
  if (!token) {
    // Named, because there are two places it could come from and the one that
    // is set per client is the one people forget. META_ACCESS_TOKEN is a
    // single token and every client has a different Page, so in practice the
    // per-client field is the answer rather than the fallback.
    return {
      state: "broken",
      reason: "No Meta access token — paste this client's on their edit page, under Instagram automation.",
    };
  }

  try {
    const v = env.meta.apiVersion;
    const qs = `access_token=${encodeURIComponent(token)}`;
    const [nameRes, rolesRes] = await Promise.all([
      fetch(`${GRAPH}/${v}/${pageId}?fields=name&${qs}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(`${GRAPH}/${v}/${pageId}/roles?${qs}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      }),
    ]);
    const nameJson = (await nameRes.json().catch(() => ({}))) as {
      name?: string;
      error?: { message?: string; code?: number };
    };
    const rolesJson = (await rolesRes.json().catch(() => ({}))) as {
      data?: unknown[];
      error?: { message?: string; code?: number };
    };

    if (nameJson.error || !nameJson.name) {
      return { state: "broken", reason: explain(nameJson.error?.message, nameJson.error?.code) };
    }
    if (rolesJson.error) {
      const message =
        rolesJson.error.code === 200
          ? `This access token does not administer "${nameJson.name}" — it was likely generated with a different Page selected in Graph API Explorer. Regenerate the token with "${nameJson.name}" selected.`
          : explain(rolesJson.error.message, rolesJson.error.code);
      return { state: "broken", reason: message };
    }
    return { state: "connected", pageName: nameJson.name };
  } catch (err) {
    return {
      state: "broken",
      reason: err instanceof Error ? err.message : "Facebook did not answer.",
    };
  }
}

/**
 * The public address of a Page post, for the task page to link to.
 *
 * Two ids come back from `/{page-id}/videos` and they are not the same
 * thing. `post_id` is `<pageId>_<postId>` — a feed post, which lives at
 * /posts/. `id` on its own is the video, and it does not live there at all:
 * asked for its own `permalink_url`, Meta answers `/reel/<id>/`.
 *
 * This built /posts/ for the first and, for the second, facebook.com/<id> —
 * a bare number after the domain, which is a profile URL for a user who does
 * not exist. Every video published without a feed post got a link that went
 * nowhere, on a page a client is shown.
 *
 * Checked against the Graph API rather than reasoned about: a real Page's
 * videos return `permalink_url: "/reel/<id>/"`.
 */
export function facebookPermalink(postId: string | null): string | null {
  if (!postId) return null;
  return postId.includes("_")
    ? `https://www.facebook.com/${postId.replace("_", "/posts/")}`
    : `https://www.facebook.com/reel/${postId}/`;
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
