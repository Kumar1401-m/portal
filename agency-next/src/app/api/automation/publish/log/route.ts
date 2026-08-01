/**
 * POST /api/automation/publish/log
 *
 * Optional breadcrumb from any intermediate step (container created, upload
 * finished, still processing…). Nothing in the workflow depends on it, but it
 * is what makes "the post went out 40 minutes late" answerable afterwards —
 * n8n's own execution history expires, `publish_attempts` doesn't.
 *
 * Always answers 200 as long as the caller is authorised: a logging failure
 * must never take down a publish that is otherwise going fine.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "deliverable_id": 12, "stage": "container_created",
 *         "container_id": "1789…", "run_id": "…", "error_message"?: "…" }
 */
import { readAuthorized, ok, asInt, asStr } from "@/lib/automation-api";
import { logPublishStage } from "@/lib/instagram";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["processing", "posted", "failed", "skipped"]);

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  const deliverableId = asInt(body.deliverable_id);
  if (!deliverableId) return ok({ logged: false, reason: "missing deliverable_id" });

  const rawStatus = (asStr(body.status) || "processing").toLowerCase();
  const status = STATUSES.has(rawStatus)
    ? (rawStatus as "processing" | "posted" | "failed" | "skipped")
    : "processing";

  try {
    await logPublishStage({
      deliverableId,
      stage: asStr(body.stage) || "step",
      status,
      containerId: asStr(body.container_id),
      mediaId: asStr(body.media_id),
      permalink: asStr(body.permalink),
      errorCode: asStr(body.error_code),
      errorMessage: asStr(body.error_message),
      durationMs: body.duration_ms == null ? null : asInt(body.duration_ms),
      runId: asStr(body.run_id),
    });
    return ok({ logged: true });
  } catch (err) {
    console.warn("[automation] log write failed:", err instanceof Error ? err.message : err);
    return ok({ logged: false });
  }
}
