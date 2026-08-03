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

    if (!videoCode) {
      // A clear command with no identifiable video. Asking is the only safe
      // move: guessing which video an unqualified "approved" refers to is how
      // the wrong video gets published.
      log.warn('command without a video code — asking the group to clarify', {
        groupId: msg.groupId,
        command: parsed.command,
      });
      await this.replySafely(
        msg.groupId,
        `I couldn't tell which video that was for. Please reply with the code, for example:\n\n` +
          `*${parsed.command.toUpperCase()} V245*\n\n` +
          `You can also reply directly to the video message.`
      );
      return { handled: false, reason: 'no_video_code' };
    }

    const payload = {
      videoId: videoCode,
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
    if (!already) await this.acknowledge(msg.groupId, parsed.command, videoCode, result.data);

    this.io?.emit('videoUpdated', {
      videoCode,
      deliverableId: result.data?.deliverableId ?? null,
      waStatus: parsed.command === 'approve' ? 'approved' : `${parsed.command}_requested`,
      status: STATUS_FOR[parsed.command],
      approvedBy: msg.senderName,
      comment: parsed.comment,
      at: new Date().toISOString(),
    });

    return { handled: true, videoCode, command: parsed.command };
  }

  /** Confirm in the group, so the client knows it registered. */
  async acknowledge(groupId, command, videoCode, data) {
    const title = data?.title ? ` — _${data.title}_` : '';
    const text =
      command === 'approve'
        ? `✅ *${videoCode}* approved${title}\nThank you! We'll schedule it for posting.`
        : command === 'change'
          ? `📝 Noted for *${videoCode}*${title}\nYour changes have gone to the editor.`
          : `🚫 *${videoCode}* marked as rejected${title}\nWe'll follow up with you.`;

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
