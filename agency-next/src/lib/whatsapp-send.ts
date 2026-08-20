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
      /**
       * Accepted, not yet in the group.
       *
       * A large file is downloaded and re-encoded before WhatsApp will take
       * it, which is minutes rather than seconds, so the service answers
       * straight away and finishes in the background. Saying "sent" about that
       * would be a lie for as long as it takes.
       */
      queued: boolean;
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
    followUps: video.followUps,
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
  /*
   * Unless the service is sending them, which it now does.
   *
   * They travel with the video job so they cannot overtake it: a big file is
   * downloaded and re-encoded in the background, and this call returns before
   * it lands — asking a client to approve a video that has not arrived is
   * worse than not asking at all. `followUpsSent` says it handled them;
   * `queued` says it will once the media is in. An older service says neither,
   * and this sends them itself exactly as before.
   */
  let asked = true;
  if (!result.followUpsSent && !result.queued) {
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
  }

  return {
    ok: true,
    videoCode: video.videoCode,
    clientName: video.clientName,
    sentAsLink: Boolean(result.sentAsLink),
    // Still being prepared: a big file is downloaded and re-encoded before it
    // can be sent, and saying "sent" about it would be a lie for a few minutes.
    queued: Boolean(result.queued),
    asked,
  };
}

/**
 * What the screen says after the button.
 *
 * Kept to a few words on purpose. This is a confirmation, not a report: the
 * paragraph that used to be here explained transcoding, follow-up messages and
 * where to look next, all of which is true and none of which anybody reads
 * while sending the next video. The approvals board is where a send is
 * actually followed — it shows every one of them and updates itself.
 *
 * The exception is the one case worth interrupting somebody for: the video
 * arrived and the question asking them to approve it did not, so the client is
 * holding a video and does not know what is wanted. That one still says so,
 * and says what to do.
 */
export function describeDelivery(r: Extract<DeliveryResult, { ok: true }>): string {
  if (!r.asked) {
    return `${r.videoCode} sent — but the review question didn't go. Send it by hand.`;
  }
  const how = r.sentAsLink ? " as a link" : "";
  return `${r.videoCode} sent to ${r.clientName}${how} ✓`;
}
