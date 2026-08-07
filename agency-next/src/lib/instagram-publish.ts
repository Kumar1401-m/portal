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
  markFailed,
  logPublishStage,
  releaseStillEncoding,
  type PublishQueueItem,
} from "./instagram";
import { sendTextToGroup } from "./whatsapp-service-client";

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
    `SELECT container_id FROM publish_attempts
      WHERE deliverable_id = ? AND container_id IS NOT NULL
        AND created_at > (NOW() - INTERVAL 2 HOUR)
      ORDER BY id DESC LIMIT 1`,
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

  // Best-effort: the post is live whether or not we can read its address back.
  let permalink: string | null = null;
  try {
    const meta = await graph(
      `${GRAPH}/${v}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    permalink = meta.permalink ?? null;
  } catch {
    /* ignore */
  }

  await markPosted({
    deliverableId: item.deliverable_id,
    mediaId: published.id,
    permalink,
    runId,
    durationMs: Date.now() - started,
  });

  await tellTheClient(item, permalink);

  return { ok: true, deliverableId: item.deliverable_id, mediaId: published.id, permalink };
}

/**
 * "Your post is live", in the client's own group.
 *
 * Never allowed to fail the publish: the post is on Instagram either way, and
 * recording it as failed because a message didn't send would be worse than the
 * client hearing it from us a little later.
 */
async function tellTheClient(item: PublishQueueItem, permalink: string | null): Promise<void> {
  if (!item.wa_chat_id) return;
  try {
    const who = item.contact_person || item.client_name;
    const text =
      `Hi ${who},\n\nYour post "${item.title}" is now live on Instagram. 🎉` +
      (permalink ? `\n\n${permalink}` : "");
    await sendTextToGroup(item.wa_chat_id, text);
  } catch (err) {
    console.warn("[publish] could not tell the client:", err instanceof Error ? err.message : err);
  }
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
