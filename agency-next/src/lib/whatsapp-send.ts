/**
 * Putting a finished video in front of the client on WhatsApp.
 *
 * Extracted so the two places that send for approval do the same thing. They
 * used not to: the button on the tasks popup set the status and emailed the
 * client, and WhatsApp only happened if someone then opened the task page and
 * pressed a second button. Two buttons named "send for approval", one of which
 * did not send anything to where the client actually replies.
 *
 * Auth belongs to the caller — this is the mechanism, not the permission.
 */
import "server-only";
import { prepareSend, markQueued, recordSendStatus } from "./whatsapp-approvals";
import { sendVideoToGroup } from "./whatsapp-service-client";

export type DeliveryResult =
  | { ok: true; videoCode: string; clientName: string; sentAsLink: boolean }
  /**
   * Nothing was attempted, and that is not necessarily a problem — a client
   * with no WhatsApp group is a client who approves by email. Kept distinct
   * from a failure so the caller can stay quiet about the first and speak up
   * about the second.
   */
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; error: string; unreachable?: boolean };

export async function deliverForApproval(deliverableId: number): Promise<DeliveryResult> {
  const prepared = await prepareSend(deliverableId);
  if (!prepared.ok) {
    // "No group linked" and "already approved" are both reasons not to send,
    // rather than failures of sending.
    return { ok: false, skipped: true, reason: prepared.error };
  }

  const { video } = prepared;
  await markQueued(deliverableId, video.groupId);

  const result = await sendVideoToGroup({
    videoCode: video.videoCode,
    deliverableId: video.deliverableId,
    groupId: video.groupId,
    videoUrl: video.videoUrl,
    watchUrl: video.watchUrl,
    caption: video.caption,
    filename: `${video.videoCode}.mp4`,
  });

  if (!result.ok) {
    // The service logs its own attempts; this covers the case where it was
    // never reached at all, so the task doesn't sit at "queued" for ever.
    await recordSendStatus({
      deliverableId,
      videoCode: video.videoCode,
      groupId: video.groupId,
      status: "failed",
      errorMessage: result.error,
    });
    return { ok: false, error: result.error, unreachable: result.unreachable };
  }

  return {
    ok: true,
    videoCode: video.videoCode,
    clientName: video.clientName,
    sentAsLink: Boolean(result.sentAsLink),
  };
}

/** One sentence describing what the client received, for the UI to echo back. */
export function describeDelivery(r: Extract<DeliveryResult, { ok: true }>): string {
  return r.sentAsLink
    ? `${r.videoCode} was too large for WhatsApp, so ${r.clientName} got the caption and a link to watch it. They can still reply APPROVE ${r.videoCode}.`
    : `${r.videoCode} sent to ${r.clientName} on WhatsApp. They'll reply APPROVE ${r.videoCode} or CHANGE ${r.videoCode}.`;
}
