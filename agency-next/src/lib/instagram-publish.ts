/**
 * Publishing a reel to Instagram, from the portal itself.
 *
 * This used to live in an n8n workflow on a server that had to be kept alive.
 * It is three HTTP calls and a wait, and the portal already owns everything
 * around them — the queue, the claim, the retry budget, the audit trail — so
 * the workflow was mostly a second place for the same state to be wrong.
 *
 * Meta's publish is deliberately two-phase and the middle is asynchronous:
 *
 *   POST /{ig}/media          → container id
 *   GET  /{container}         → status_code, until FINISHED
 *   POST /{ig}/media_publish  → the post
 *
 * A large reel can sit in IN_PROGRESS for a minute or more, which is longer
 * than a serverless function should be held open. So this is written to be
 * resumable: each run does what it can and returns, and the next run picks the
 * same video up where it stopped. What must never happen is a second container
 * for the same video — that publishes it twice — so the container id is
 * recovered from the audit trail before any new one is created.
 */
import "server-only";
import { query, queryOne } from "./db";
import { env } from "./env";
import {
  claimForPublish,
  markPosted,
  setPermalink,
  markFailed,
  logPublishStage,
  releaseStillEncoding,
  type PublishQueueItem,
} from "./instagram";
import { sendTextToGroup } from "./whatsapp-service-client";
import { notifyAdmins } from "./notify";
import { publishToPage, facebookPermalink } from "./facebook";

const GRAPH = "https://graph.facebook.com";

/** How long to wait for a container within one run before leaving it. */
const POLL_ATTEMPTS = 6;
const POLL_GAP_MS = 3000;

export type PublishOutcome =
  | { ok: true; deliverableId: number; mediaId: string; permalink: string | null }
  | { ok: true; deliverableId: number; pending: true; containerId: string }
  | { ok: false; deliverableId: number; error: string; permanent: boolean };

type Graph = { id?: string; status_code?: string; status?: string; permalink?: string; error?: { message?: string; code?: number; error_subcode?: number } };

async function graph(url: string, init?: RequestInit): Promise<Graph> {
  const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as Graph;
}

/**
 * A container this video already has, from an earlier run.
 *
 * Read from the audit trail rather than a column on the deliverable: the trail
 * is written for every stage anyway, and one source of truth beats two that
 * can disagree about whether a container exists.
 */
async function existingContainer(deliverableId: number): Promise<string | null> {
  const row = await queryOne<{ container_id: string | null }>(
    `SELECT p.container_id FROM publish_attempts p
      WHERE p.deliverable_id = ? AND p.container_id IS NOT NULL
        AND p.created_at > (NOW() - INTERVAL 2 HOUR)
        /*
         * Never a container that has already been through media_publish.
         *
         * Resuming an unfinished container is the point of this lookup, and it
         * saves re-uploading a video Instagram is already encoding. Resuming a
         * *published* one would post the same reel to the client's feed twice
         * — the one failure here that cannot be undone from the portal.
         */
        AND NOT EXISTS (
          SELECT 1 FROM publish_attempts q
           WHERE q.deliverable_id = p.deliverable_id
             AND q.container_id = p.container_id
             AND (q.media_id IS NOT NULL OR q.status = 'posted')
        )
      ORDER BY p.id DESC LIMIT 1`,
    [deliverableId]
  );
  return row?.container_id ?? null;
}

/**
 * Take one video all the way, or as far as this run can get.
 *
 * The caller must have claimed it — that claim is what stops two runs
 * publishing the same reel, and it is not re-checked here.
 */
export async function publishClaimed(item: PublishQueueItem, runId: string): Promise<PublishOutcome> {
  const token = item.ig_access_token || env.meta.accessToken;
  if (!token) {
    await markFailed({
      deliverableId: item.deliverable_id,
      errorMessage: "No Meta access token configured.",
      stage: "container",
      permanent: true,
      runId,
    });
    return { ok: false, deliverableId: item.deliverable_id, error: "No Meta access token configured.", permanent: true };
  }

  const v = env.meta.apiVersion;
  const started = Date.now();

  /* ---------------- 1. The container, or the one we already made ---------------- */
  let containerId = await existingContainer(item.deliverable_id);

  if (!containerId) {
    const body = new URLSearchParams({
      video_url: item.video_url,
      caption: item.caption,
      access_token: token,
      ...(item.media_type === "REELS" ? { media_type: "REELS" } : {}),
    });

    const created = await graph(`${GRAPH}/${v}/${item.ig_user_id}/media`, {
      method: "POST",
      body,
    });

    if (created.error || !created.id) {
      const message = created.error?.message || "Instagram refused the video.";
      // A 400 is a fact about the request — a bad token, a wrong account id, a
      // video Instagram will never accept. Retrying spends the budget for
      // nothing and delays the human who has to fix it.
      const permanent = created.error?.code === 100 || created.error?.code === 190;
      await markFailed({
        deliverableId: item.deliverable_id,
        errorMessage: message,
        errorCode: String(created.error?.code ?? ""),
        stage: "container",
        permanent,
        runId,
      });
      return { ok: false, deliverableId: item.deliverable_id, error: message, permanent };
    }

    containerId = created.id;
    await logPublishStage({
      deliverableId: item.deliverable_id,
      clientId: item.client_id,
      stage: "container",
      status: "processing",
      containerId,
      runId,
      attemptNo: item.attempt_no,
    });
  }

  /* ---------------- 2. Wait for Instagram to finish with it ---------------- */
  let ready = false;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const status = await graph(
      `${GRAPH}/${v}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
    );

    if (status.status_code === "FINISHED") {
      ready = true;
      break;
    }
    if (status.status_code === "ERROR" || status.error) {
      const message = status.status || status.error?.message || "Instagram could not process the video.";
      await markFailed({
        deliverableId: item.deliverable_id,
        errorMessage: message,
        stage: "processing",
        // The file itself is the problem; a retry uploads the same bytes.
        permanent: true,
        runId,
      });
      return { ok: false, deliverableId: item.deliverable_id, error: message, permanent: true };
    }
    await new Promise((r) => setTimeout(r, POLL_GAP_MS));
  }

  if (!ready) {
    /*
     * Still encoding — hand it straight back.
     *
     * Holding the claim would mean waiting out its twenty-minute lease before
     * anything looked at this video again, on an encode that is usually done
     * in well under a minute. The container id is in the trail, so whichever
     * run picks it up next resumes that container instead of making another.
     */
    await logPublishStage({
      deliverableId: item.deliverable_id,
      clientId: item.client_id,
      stage: "processing",
      status: "processing",
      containerId,
      runId,
      attemptNo: item.attempt_no,
    });
    await releaseStillEncoding(item.deliverable_id);
    return { ok: true, deliverableId: item.deliverable_id, pending: true, containerId };
  }

  /* ---------------- 3. Publish ---------------- */
  const published = await graph(`${GRAPH}/${v}/${item.ig_user_id}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });

  if (published.error || !published.id) {
    const message = published.error?.message || "Instagram refused to publish the container.";
    await markFailed({
      deliverableId: item.deliverable_id,
      errorMessage: message,
      errorCode: String(published.error?.code ?? ""),
      stage: "publish",
      runId,
    });
    return { ok: false, deliverableId: item.deliverable_id, error: message, permanent: false };
  }

  /*
   * Record it before doing anything else with it.
   *
   * media_publish is the irreversible step: the reel is on the client's feed
   * the instant it returns. Everything after it is optional, and every
   * millisecond between it and the write is a window where this function can
   * be killed — a serverless function has no say in that — leaving a post that
   * is live and a database that does not know. The row would stay `processing`
   * until its lease expired, be picked up again, reuse the same container from
   * the trail, and publish it a second time.
   *
   * The permalink lookup used to sit in that window: a Graph round trip with a
   * thirty-second timeout, run before the write, for a field that is only ever
   * a convenience link. It now happens after, and updates the row separately.
   */
  await markPosted({
    deliverableId: item.deliverable_id,
    mediaId: published.id,
    permalink: null,
    runId,
    durationMs: Date.now() - started,
    // Stamped against the container, so `existingContainer` can see this one
    // is spent and never hands it back to a later run.
    containerId,
  });

  // Best-effort: the post is live whether or not we can read its address back.
  let permalink: string | null = null;
  try {
    const meta = await graph(
      `${GRAPH}/${v}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    permalink = meta.permalink ?? null;
    if (permalink) await setPermalink(item.deliverable_id, published.id, permalink);
  } catch {
    /* a missing link is cosmetic; the post and its media id are recorded */
  }

  /*
   * And the same post on their Facebook Page.
   *
   * After the Instagram write, never before it, and never able to affect its
   * outcome: the reel is live by this point and the row says so. A Page that
   * refuses the video is something to record and show — marking the whole
   * publish failed would invite a retry, and the retry would post to Instagram
   * a second time.
   *
   * Meta is handed the same URL it has just fetched for Instagram, so this is
   * one HTTP call rather than a second upload.
   */
  const fb = await publishToPage({
    deliverableId: item.deliverable_id,
    pageId: item.fb_page_id,
    token,
    mediaUrl: item.video_url,
    mediaType: item.media_type,
    caption: item.caption,
  }).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : "Facebook failed.",
  }));

  if (!fb.ok && !("skipped" in fb && fb.skipped)) {
    // Said once, in the run's own log. The row carries the reason, and the
    // task page shows it — this is for whoever is reading why a run was noisy.
    console.warn(`[publish] ${item.deliverable_id} is live on Instagram but not on Facebook:`, fb.error);

    /*
     * And told to somebody, because half-posted appears on no board.
     *
     * "Not posted" lists what never reached Instagram; this reached Instagram
     * and stopped. The task page shows it, but nobody opens the task page of a
     * video that published successfully — so without this the client's Page
     * quietly runs a month behind their feed and the first to notice is the
     * client.
     */
    await notifyAdmins(
      "publish_partial",
      `${item.client_name}: on Instagram, not on Facebook`,
      `"${item.title}" published to Instagram but the Page refused it — ${fb.error}`,
      `/deliverables/${item.deliverable_id}`
    ).catch(() => {});
  }

  await tellTheClient(item, permalink, fb.ok ? fb.postId : null);

  return { ok: true, deliverableId: item.deliverable_id, mediaId: published.id, permalink };
}

/**
 * "Your post is live", in the client's own group.
 *
 * Never allowed to fail the publish: the post is on Instagram either way, and
 * recording it as failed because a message didn't send would be worse than the
 * client hearing it from us a little later.
 */
async function tellTheClient(
  item: PublishQueueItem,
  permalink: string | null,
  /**
   * The Page post's id, or null when it did not go there.
   *
   * The message used to carry the Instagram link alone while claiming the post
   * was live "on Instagram and Facebook" — so a client told about two posts
   * was handed one address and left to find the other themselves, on the
   * account they pay us to run. Both links or neither claim.
   */
  facebookPostId: string | null
): Promise<void> {
  if (!item.wa_chat_id) return;
  try {
    const who = item.contact_person || item.client_name;
    const fbLink = facebookPermalink(facebookPostId);

    /*
     * One line per place, each with its own address.
     *
     * Labelled rather than run together: two bare URLs in a row is the shape
     * of a forwarded advert, and a client scanning their group needs to know
     * which is which without opening both. Facebook is named only when it
     * actually went — telling somebody their post is on a Page that refused
     * it is the one version of this message worth never sending.
     */
    const lines = [
      permalink ? `Instagram: ${permalink}` : null,
      fbLink ? `Facebook: ${fbLink}` : null,
    ].filter(Boolean);

    const where = facebookPostId ? "Instagram and Facebook" : "Instagram";
    const text =
      `Hi ${who},\n\nYour post "${item.title}" is now live on ${where}. 🎉` +
      (lines.length ? `\n\n${lines.join("\n")}` : "");
    await sendTextToGroup(item.wa_chat_id, text);
  } catch (err) {
    console.warn("[publish] could not tell the client:", err instanceof Error ? err.message : err);
  }
}

/**
 * Publish one video now, without waiting for its slot.
 *
 * The scheduler answers "when", and the answer is sometimes "not for another
 * six hours" when what is wanted is "now". Everything else the publisher
 * checks still applies — an Instagram account, a video, a token — because
 * those are not preferences, they are what the Graph API needs. Only the
 * clock and the client's auto-publish preference are set aside, and both are
 * for the same reason: a person is standing here asking for this one post, so
 * neither "it isn't six o'clock" nor "don't do this unattended" is an answer.
 *
 * Goes through exactly the same claim and publish path as the automatic run.
 * A second implementation of publishing would be a second set of bugs, and
 * the claim is what stops this racing the scheduled run happening at the same
 * moment.
 */
export async function publishNow(
  deliverableId: number
): Promise<{ ok: true; permalink: string | null } | { ok: false; error: string; pending?: boolean }> {
  const { retryPublish, claimForPublish, getPublishInfo } = await import("./instagram");

  const info = await getPublishInfo(deliverableId);
  if (!info) return { ok: false, error: "Publishing isn't set up on this database." };
  if (info.instagramStatus === "posted") return { ok: false, error: "This is already on Instagram." };

  /*
   * Asked before anything is claimed, so a missing token costs nothing.
   *
   * Otherwise this ends in publishClaimed marking the video permanently
   * failed for a setting nobody has filled in — and the person who pressed the
   * button gets a failure that reads like the video was rejected.
   */
  const { publishingReadiness } = await import("./instagram");
  const readiness = await publishingReadiness();
  if (!readiness.ready) return { ok: false, error: readiness.reason ?? "Publishing isn't set up." };

  /*
   * Only the blockers a person cannot overrule from here.
   *
   * "Auto-publishing is off" and "no posting time is set" both stop the
   * unattended run and neither should stop this one — pressing the button is
   * the missing consent and the missing time.
   *
   * So is a closed window, and that one was a contradiction: the blocker text
   * ends "Move the date to the next day, or use Post now", and using Post now
   * returned that same sentence back as the reason it would not. The window
   * exists to stop the *unattended* publisher going out at 3am. A person
   * pressing this at 3am has decided otherwise, which is what the button is.
   *
   * The rest are real: without an account or a video there is nothing to send.
   */
  const fatal = info.blockers.filter(
    (b) =>
      !/^Auto-publishing is off/.test(b) &&
      !/^No posting time is set/.test(b) &&
      !/^Its window /.test(b) &&
      !/^It has used all/.test(b)
  );
  if (fatal.length) return { ok: false, error: fatal[0] };

  // Resets the attempt count and puts the row in the one state the claim
  // accepts — the same door "Try posting again" uses.
  await retryPublish(deliverableId);

  const runId = `manual-${deliverableId}`;
  const claim = await claimForPublish(deliverableId, runId);
  if (!claim.ok) {
    return {
      ok: false,
      error:
        claim.reason === "claimed_elsewhere"
          ? "The publisher is already working on this one — give it a minute."
          : `Couldn't take it for publishing (${claim.reason}).`,
    };
  }

  const out = await publishClaimed(claim.item, runId);
  if (!out.ok) return { ok: false, error: out.error };
  if ("pending" in out) {
    return {
      ok: false,
      pending: true,
      error: "Instagram is still encoding the video. It will go out on the next run, within 15 minutes.",
    };
  }
  return { ok: true, permalink: out.permalink };
}

export type RunSummary = {
  considered: number;
  posted: number;
  pending: number;
  failed: number;
  results: { deliverableId: number; outcome: string; detail?: string }[];
};

/**
 * One pass over whatever is due.
 *
 * Deliberately a small batch. Each video costs an upload wait, and a run that
 * tried to clear a backlog would be killed by the platform partway through —
 * losing nothing, since everything is resumable, but achieving nothing either.
 */
export async function runPublisher(limit = 3): Promise<RunSummary> {
  const runId = `portal-${Date.now().toString(36)}`;
  const { getPublishQueue } = await import("./instagram");
  const due = await getPublishQueue(limit);

  const summary: RunSummary = { considered: due.length, posted: 0, pending: 0, failed: 0, results: [] };

  for (const item of due) {
    const claim = await claimForPublish(item.deliverable_id, runId);
    if (!claim.ok) {
      summary.results.push({ deliverableId: item.deliverable_id, outcome: "skipped", detail: claim.reason });
      continue;
    }

    try {
      const out = await publishClaimed(claim.item, runId);
      if (!out.ok) {
        summary.failed++;
        summary.results.push({ deliverableId: out.deliverableId, outcome: "failed", detail: out.error });
      } else if ("pending" in out) {
        summary.pending++;
        summary.results.push({ deliverableId: out.deliverableId, outcome: "still encoding" });
      } else {
        summary.posted++;
        summary.results.push({ deliverableId: out.deliverableId, outcome: "posted", detail: out.permalink ?? undefined });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await markFailed({
        deliverableId: item.deliverable_id,
        errorMessage: message,
        stage: "publish",
        runId,
      });
      summary.failed++;
      summary.results.push({ deliverableId: item.deliverable_id, outcome: "failed", detail: message });
    }
  }

  void query;
  return summary;
}
