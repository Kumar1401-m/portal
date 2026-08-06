'use strict';

/**
 * Retrying video sends.
 *
 * A send fails for two very different reasons and they need opposite handling:
 *
 *   Transient — WhatsApp reconnecting, R2 hiccup, a timeout. Retry with
 *     backoff; it usually lands on the second attempt.
 *   Permanent — the file is too large, the group id is wrong, the account is
 *     logged out. Retrying is pure noise, and worse, it delays the log line
 *     that tells someone what to actually fix.
 *
 * Every attempt is reported to the portal so the send log is complete, not
 * just the final outcome. "It went out on the third try, 90 seconds late" is
 * the answer to a question someone will eventually ask.
 */
const { config } = require('../config');
const { createLogger } = require('./logger');
const { reportSendStatus } = require('./portal-client');

const log = createLogger('send-queue');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error codes that will fail identically however many times we try. */
const PERMANENT_CODES = new Set(['media_too_large', 'bad_group', 'media_fetch_failed']);

class SendQueue {
  constructor(whatsapp, io) {
    this.whatsapp = whatsapp;
    this.io = io;
    /** Jobs currently in flight, keyed by video code — see `submit`. */
    this.inFlight = new Map();
  }

  /**
   * Queue a video for sending.
   *
   * Deduplicated by video code: a double-click on "Send for approval", or the
   * portal retrying a timed-out call, must not put the same video into a
   * client's group twice. The second caller joins the first job's promise.
   */
  submit(job) {
    const key = job.videoCode || `${job.groupId}:${job.videoUrl}`;

    const existing = this.inFlight.get(key);
    if (existing) {
      log.info('already sending this video — joining the in-flight job', { key });
      return existing;
    }

    const promise = this.run(job).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async run(job) {
    const { videoCode, deliverableId, groupId, videoUrl, watchUrl, caption, filename } = job;
    const maxAttempts = config.send.maxAttempts;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.report({
        deliverableId,
        videoCode,
        groupId,
        attemptNo: attempt,
        status: 'sending',
      });

      try {
        const result = await this.whatsapp.enqueueSend({
          groupId,
          videoUrl,
          // Carried through so an oversized video can fall back to a link
          // rather than failing. Rebuilding this object field by field is how
          // it went missing the first time.
          watchUrl,
          caption,
          filename,
        });

        log.info('sent', { videoCode, groupId, attempt, ms: result.durationMs });

        await this.report({
          deliverableId,
          videoCode,
          groupId,
          attemptNo: attempt,
          status: 'sent',
          waMessageId: result.messageId,
          mediaBytes: result.bytes,
          durationMs: result.durationMs,
        });

        this.io?.emit('videoUpdated', {
          videoCode,
          deliverableId,
          waStatus: 'sent',
          at: new Date().toISOString(),
        });

        // sentAsLink is carried out so the portal can say the client got a
        // link rather than the file — the same rebuild-by-field that lost
        // watchUrl on the way in would otherwise lose this on the way out.
        return {
          ok: true,
          messageId: result.messageId,
          attempts: attempt,
          ...(result.sentAsLink ? { sentAsLink: true } : {}),
        };
      } catch (err) {
        lastError = err;
        const permanent = err.permanent === true || PERMANENT_CODES.has(err.code);

        log.warn('send failed', {
          videoCode,
          attempt,
          code: err.code,
          permanent,
          error: err.message,
        });

        await this.report({
          deliverableId,
          videoCode,
          groupId,
          attemptNo: attempt,
          status: 'failed',
          errorCode: err.code || null,
          errorMessage: err.message,
        });

        if (permanent) {
          this.io?.emit('videoUpdated', {
            videoCode,
            deliverableId,
            waStatus: 'failed',
            error: err.message,
          });
          return { ok: false, permanent: true, error: err.message, attempts: attempt };
        }

        if (attempt < maxAttempts) {
          const delay = config.send.retryDelayMs * 2 ** (attempt - 1);
          log.info('retrying', { videoCode, inMs: delay });
          await sleep(delay);
        }
      }
    }

    this.io?.emit('videoUpdated', {
      videoCode,
      deliverableId,
      waStatus: 'failed',
      error: lastError?.message,
    });

    return {
      ok: false,
      permanent: false,
      error: lastError?.message || 'Send failed',
      attempts: maxAttempts,
    };
  }

  /** Never let a reporting failure break a send that otherwise worked. */
  async report(payload) {
    try {
      await reportSendStatus(payload);
    } catch (err) {
      log.warn('could not report send status', { error: err.message });
    }
  }
}

module.exports = { SendQueue };
