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
import { sendVideoToGroup, sendTextToGroup } from "./whatsapp-service-client";

export type DeliveryResult =
  | {
      ok: true;
      videoCode: string;
      clientName: string;
      sentAsLink: boolean;
      /** False when the video went but the "please review" message did not. */
      asked: boolean;
    }
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
    caption: video.mediaCaption,
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

  /*
   * Then the question, as its own message.
   *
   * After the video, never with it: the first message is the post exactly as
   * it will appear, and this one is the agency asking about it. Bundled
   * together, a client checking the caption had to read past our reply
   * instructions to find where their copy ended.
   *
   * Best-effort, and deliberately not able to fail the delivery. The video is
   * already in the group by this point; reporting the whole send as failed
   * would invite a retry, and the retry would post the video a second time.
   * A client left holding a video with no question is recoverable by one
   * message — a client sent the same video twice is not.
   */
  let asked = true;
  for (const text of video.followUps) {
    const sent = await sendTextToGroup(video.groupId, text);
    if (!sent.ok) {
      asked = false;
      console.warn(
        `[whatsapp] ${video.videoCode} sent, but the follow-up did not:`,
        sent.error
      );
      break;
    }
  }

  return {
    ok: true,
    videoCode: video.videoCode,
    clientName: video.clientName,
    sentAsLink: Boolean(result.sentAsLink),
    asked,
  };
}

/** One sentence describing what the client received, for the UI to echo back. */
export function describeDelivery(r: Extract<DeliveryResult, { ok: true }>): string {
  const what = r.sentAsLink
    ? `${r.videoCode} was too large for WhatsApp, so ${r.clientName} got a link to watch it, then the caption.`
    : `${r.videoCode} sent to ${r.clientName} on WhatsApp, followed by the caption.`;

  // Said plainly, because it is the one case where the client has the video
  // and does not know what is being asked of them.
  return r.asked
    ? `${what} They can reply OK to approve, or CHANGE with what to adjust.`
    : `${what} The "please review" message did not go through — send it by hand, or press send again once WhatsApp is back.`;
}
