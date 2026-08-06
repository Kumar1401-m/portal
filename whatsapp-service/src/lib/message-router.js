'use strict';

/**
 * Turning an inbound group message into a portal action.
 *
 * Everything from a group is logged; only recognised commands cause an
 * approval. The two are reported separately so the transcript stays complete
 * even when nothing was parsed — most messages in a client group are ordinary
 * conversation, and that context is what makes the log worth keeping.
 *
 * Idempotency lives in the portal, keyed on the WhatsApp message id. This
 * matters more than it looks: whatsapp-web.js replays recent messages after a
 * reconnect, so the same "APPROVE V245" can arrive two or three times.
 */
const { createLogger } = require('./logger');
const { parseCommand, findCode } = require('./command-parser');
const { transcribeVoice } = require('./portal-client');
const { reportApproval, logMessage } = require('./portal-client');

const log = createLogger('router');

/** Command → the status the portal should record. */
const STATUS_FOR = {
  approve: 'Approved',
  change: 'Changes Requested',
  reject: 'Rejected',
};

class MessageRouter {
  constructor(whatsapp, io) {
    this.whatsapp = whatsapp;
    this.io = io;
  }

  async handle(msg) {
    // A voice note arrives with an empty body; its words have to be fetched
    // before anything can be parsed from them.
    if (msg.isVoice && !String(msg.body || '').trim()) {
      const spoken = await this.transcribe(msg);
      if (spoken) {
        log.info('voice note transcribed', { groupId: msg.groupId, chars: spoken.length });
        msg = { ...msg, body: spoken, transcribed: true };
      } else {
        // Log it as a voice note so the timeline shows something arrived, then
        // leave it alone — a reply we cannot read is not one we should guess at.
        msg = { ...msg, body: '[voice note — could not be transcribed]' };
      }
    }

    const parsed = parseCommand(msg.body);

    // A client who replies to the video message itself doesn't need to type the
    // code — recover it from the quoted caption, which contains "Video ID: V245".
    let videoCode = parsed.videoCode;
    if (!videoCode && parsed.command !== 'none' && msg.quotedText) {
      videoCode = findCode(msg.quotedText);
      if (videoCode) {
        log.info('recovered the video code from the quoted message', { videoCode });
      }
    }

    // Log first, always, and independently of whether a command was found.
    // Doing this before the approval means a crash in approval handling still
    // leaves evidence that the client replied.
    await this.log(msg, parsed.command, videoCode);

    if (parsed.command === 'none') {
      log.debug('ordinary chatter, no command', { groupId: msg.groupId });
      return { handled: false };
    }

    const payload = {
      videoId: videoCode || null,
      status: STATUS_FOR[parsed.command],
      command: parsed.command,
      approvedBy: msg.senderName,
      approvedNumber: msg.senderNumber,
      message: msg.body,
      comment: parsed.comment,
      groupId: msg.groupId,
      groupName: msg.groupName,
      waMessageId: msg.messageId,
      time: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : new Date().toISOString(),
    };

    log.info('approval command', {
      videoCode,
      command: parsed.command,
      by: msg.senderName,
      hasComment: Boolean(parsed.comment),
    });

    const result = await reportApproval(payload);

    if (!result.ok) {
      // A 4xx means the portal understood and refused — usually an unknown
      // video code, which the client can fix themselves if we tell them.
      if (result.permanent) {
        const reason = result.data?.error || 'that video code was not recognised';
        /*
         * Two videos waiting in one group is the only case the portal cannot
         * settle on its own. Its message already names a code to use, so it is
         * passed through as-is rather than wrapped in a warning — this is a
         * question for the client, not a failure to report at them.
         */
        if (result.data?.ambiguous) {
          await this.replySafely(msg.groupId, reason);
          return { handled: false, reason: 'ambiguous' };
        }
        await this.replySafely(msg.groupId, `⚠️ Couldn't record that: ${reason}`);
        return { handled: false, reason: 'portal_rejected' };
      }
      // A 5xx or unreachable portal is our problem, not the client's. Stay
      // quiet rather than blaming them for an outage; the log has it, and the
      // portal's own retry will pick it up.
      log.error('portal unreachable — approval not recorded', { videoCode });
      return { handled: false, reason: 'portal_unreachable' };
    }

    const already = result.data?.alreadyRecorded === true;
    // The portal may have resolved the code itself, so prefer what it sends
    // back over what the client typed (which, increasingly, is nothing).
    const settledCode = result.data?.videoCode || videoCode;
    if (!already) await this.acknowledge(msg.groupId, parsed.command, settledCode, result.data);

    this.io?.emit('videoUpdated', {
      videoCode: settledCode,
      deliverableId: result.data?.deliverableId ?? null,
      waStatus: parsed.command === 'approve' ? 'approved' : `${parsed.command}_requested`,
      status: STATUS_FOR[parsed.command],
      approvedBy: msg.senderName,
      comment: parsed.comment,
      at: new Date().toISOString(),
    });

    return { handled: true, videoCode: settledCode, command: parsed.command };
  }

  /** Confirm in the group, so the client knows it registered. */
  async acknowledge(groupId, command, videoCode, data) {
    const title = data?.title ? ` — _${data.title}_` : '';
    // A code is shown only if there is one; the client no longer sees codes
    // and echoing "undefined" back at them would be worse than saying nothing.
    const ref = videoCode ? `*${videoCode}* ` : '';
    const text =
      command === 'approve'
        ? `✅ ${ref}Approved${title}\nThank you! We'll schedule it for posting.`
        : command === 'change'
          ? `📝 Noted${title}\nYour changes have gone to the editor.`
          : `🚫 ${ref}Marked as rejected${title}\nWe'll follow up with you.`;

    await this.replySafely(groupId, text);
  }

  /**
   * Send a reply, swallowing failure.
   *
   * The approval is already recorded by this point. Failing the whole operation
   * because a courtesy message didn't send would turn a cosmetic problem into a
   * lost approval.
   */
  async replySafely(groupId, text) {
    try {
      await this.whatsapp.sendText(groupId, text);
    } catch (err) {
      log.warn('could not send the acknowledgement', { groupId, error: err.message });
    }
  }

  /**
   * The words in a voice note, or null.
   *
   * Never throws: transcription is an enhancement to a message that has
   * already arrived, and a failure here must not stop it being logged.
   */
  async transcribe(msg) {
    try {
      const media = await msg.downloadMedia();
      if (!media?.data) return null;
      const result = await transcribeVoice({
        audioBase64: media.data,
        mimeType: media.mimetype || 'audio/ogg',
        groupId: msg.groupId,
      });
      const text = result?.data?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    } catch (err) {
      log.warn('could not transcribe the voice note', { error: err.message });
      return null;
    }
  }

  async log(msg, command, videoCode) {
    try {
      await logMessage({
        waMessageId: msg.messageId,
        groupId: msg.groupId,
        groupName: msg.groupName,
        senderName: msg.senderName,
        senderNumber: msg.senderNumber,
        message: msg.body,
        videoCode: videoCode ?? null,
        parsedCommand: command,
        direction: 'in',
        time: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      log.warn('could not log the message', { error: err.message });
    }
  }
}

module.exports = { MessageRouter };
