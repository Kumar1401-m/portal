'use strict';

/**
 * HTTP surface of the WhatsApp service.
 *
 * Two audiences with different needs:
 *
 *   /health   — unauthenticated, for Docker and uptime checks. Deliberately
 *               reveals nothing beyond liveness and connection state.
 *   /api/*    — authenticated with SERVICE_API_KEY, called by the portal.
 *
 * Everything answers JSON with an `ok` field so the caller only ever has to
 * look at one thing.
 */
const express = require('express');
const { config } = require('../config');
const { createLogger } = require('../lib/logger');

const log = createLogger('routes');

/** Constant-time compare, so key checks don't leak length or content. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Bearer auth. Header only — a key in a query string ends up in access logs. */
function requireKey(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!safeEqual(token, config.serviceKey)) {
    log.warn('unauthorised request', { path: req.path, ip: req.ip });
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

function buildRoutes({ whatsapp, sendQueue }) {
  const router = express.Router();

  /* --------------------------------- Health -------------------------------- */

  router.get('/health', (_req, res) => {
    const status = whatsapp.status();
    // 200 even when disconnected: the SERVICE is healthy, the SESSION isn't.
    // Returning 503 here would make Docker restart the container on a WhatsApp
    // logout, throwing away the browser and achieving nothing.
    res.json({
      ok: true,
      service: 'whatsapp-approval-service',
      state: status.state,
      connected: status.connected,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  router.use('/api', requireKey);

  /* -------------------------------- Session -------------------------------- */

  router.get('/api/status', (_req, res) => {
    res.json({ ok: true, ...whatsapp.status() });
  });

  /**
   * The QR image, for the portal's settings page.
   *
   * Returns 409 rather than 404 when there's nothing to scan: "already logged
   * in" and "no such endpoint" are very different answers to the same request,
   * and the UI branches on it.
   */
  router.get('/api/qr', (_req, res) => {
    const status = whatsapp.status();
    if (!whatsapp.qrDataUrl) {
      return res.status(409).json({
        ok: false,
        error: status.connected
          ? 'Already connected — no QR code needed.'
          : 'No QR code available yet. Try Reconnect, then check again in a few seconds.',
        state: status.state,
      });
    }
    res.json({ ok: true, dataUrl: whatsapp.qrDataUrl, generatedAt: whatsapp.qrGeneratedAt });
  });

  router.post('/api/reconnect', async (_req, res) => {
    try {
      await whatsapp.reconnect();
      res.json({ ok: true, ...whatsapp.status() });
    } catch (err) {
      log.error('reconnect failed', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Log out and discard the session. Requires an explicit confirmation field —
   * this forces a physical QR re-scan, so it must not be reachable by an
   * accidental POST.
   */
  router.post('/api/logout', async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        ok: false,
        error: 'Send {"confirm":true} — logging out requires re-scanning the QR code in person.',
      });
    }
    try {
      await whatsapp.logout();
      res.json({ ok: true, ...whatsapp.status() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /* --------------------------------- Groups -------------------------------- */

  router.get('/api/groups', async (_req, res) => {
    if (!whatsapp.status().connected) {
      return res.status(409).json({ ok: false, error: 'WhatsApp is not connected.' });
    }
    try {
      // Answers ok:true even with an empty list. A group picker that can't
      // enumerate is a degraded picker, not a failed request — and reporting
      // it as an error makes a working connection look broken.
      const { groups, warning } = await whatsapp.listGroups();
      res.json({ ok: true, count: groups.length, groups, warning });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'Could not list groups' });
    }
  });

  /* ---------------------------------- Send --------------------------------- */

  /**
   * POST /api/send-video
   *
   * Queues one approval video. Returns as soon as the send resolves — the
   * portal wants to know whether it went, and a video send is seconds, not
   * minutes. Retries happen inside the queue before this resolves.
   *
   * Body: { videoCode, deliverableId, groupId, videoUrl, caption?, filename? }
   */
  router.post('/api/send-video', async (req, res) => {
    const { videoCode, deliverableId, groupId, videoUrl, watchUrl, caption, filename } = req.body || {};

    const missing = [];
    if (!videoCode) missing.push('videoCode');
    if (!groupId) missing.push('groupId');
    if (!videoUrl) missing.push('videoUrl');
    if (missing.length) {
      return res.status(400).json({ ok: false, error: `Missing: ${missing.join(', ')}` });
    }

    if (!/^https?:\/\//i.test(videoUrl)) {
      return res.status(400).json({ ok: false, error: 'videoUrl must be an http(s) URL.' });
    }
    if (!String(groupId).endsWith('@g.us')) {
      return res.status(400).json({
        ok: false,
        error: 'groupId must be a WhatsApp group id ending in @g.us.',
      });
    }

    if (!whatsapp.status().connected) {
      // 503, not 500: the portal should retry this later rather than mark the
      // video as permanently failed.
      return res.status(503).json({
        ok: false,
        error: `WhatsApp is not connected (${whatsapp.status().state}).`,
        state: whatsapp.status().state,
      });
    }

    try {
      const result = await sendQueue.submit({
        videoCode,
        deliverableId: deliverableId ?? null,
        groupId,
        videoUrl,
        // Used only if WhatsApp refuses the file for its size.
        watchUrl: watchUrl || null,
        caption: caption || defaultCaption(videoCode),
        filename: filename || `${videoCode}.mp4`,
      });

      if (!result.ok) {
        return res.status(result.permanent ? 422 : 502).json({
          ok: false,
          error: result.error,
          permanent: Boolean(result.permanent),
          attempts: result.attempts,
        });
      }

      res.json({ ok: true, ...result });
    } catch (err) {
      log.error('send-video failed', { videoCode, error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Plain text into a group — reminders, follow-ups. */
  router.post('/api/send-text', async (req, res) => {
    const { groupId, text } = req.body || {};
    if (!groupId || !text) {
      return res.status(400).json({ ok: false, error: 'groupId and text are required.' });
    }
    if (!whatsapp.status().connected) {
      return res.status(503).json({ ok: false, error: 'WhatsApp is not connected.' });
    }
    try {
      const result = await whatsapp.sendText(groupId, String(text).slice(0, 4096));
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

/**
 * The caption a client sees. Kept here so the reply syntax and the parser can
 * never drift apart — the instructions shown are exactly what is accepted.
 */
function defaultCaption(videoCode) {
  return (
    `📹 *Video Ready*\n\n` +
    `Video ID: *${videoCode}*\n\n` +
    `Please review and reply:\n\n` +
    `✅ *APPROVE ${videoCode}*\n` +
    `📝 *CHANGE ${videoCode}* (then your notes)\n\n` +
    `_You can also reply directly to this message._`
  );
}

module.exports = { buildRoutes, defaultCaption };
