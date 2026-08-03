'use strict';

/**
 * Calling back into the Next.js portal.
 *
 * The portal is the system of record: this service holds no database. Every
 * approval, message and status change is forwarded there, and the portal
 * decides what it means.
 *
 * Callbacks are retried with backoff, because the alternative is losing a
 * client's approval to a thirty-second deploy. The portal's endpoints are
 * idempotent (keyed on the WhatsApp message id), so retrying is always safe.
 */
const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('portal');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to the portal with retries.
 *
 * 4xx is not retried — a rejected payload will be rejected identically next
 * time, and hammering it just delays the log line that explains why. 5xx and
 * network failures are retried: those are usually a restart or a cold start.
 */
async function post(path, body, { attempts = 4, baseDelayMs = 2000 } = {}) {
  const url = `${config.portal.url}${path}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.portal.timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.portal.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 500) };
      }

      if (res.ok) {
        log.debug('callback ok', { path, attempt, ms: Date.now() - started });
        return { ok: true, status: res.status, data: json };
      }

      if (res.status >= 400 && res.status < 500) {
        log.error('portal rejected the callback', {
          path,
          status: res.status,
          error: json.error || json.raw,
        });
        return { ok: false, status: res.status, data: json, permanent: true };
      }

      log.warn('portal error, will retry', { path, status: res.status, attempt });
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      log.warn('callback failed, will retry', { path, attempt, reason });
    }

    if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }

  log.error('callback permanently failed', { path, attempts });
  return { ok: false, permanent: false, error: 'Portal unreachable after retries' };
}

/** A client replied APPROVE / CHANGE / REJECT in their group. */
const reportApproval = (payload) => post('/api/whatsapp/approve', payload);

/** Every inbound group message, command or not — the transcript. */
const logMessage = (payload) => post('/api/whatsapp/message', payload);

/** Outbound send outcome: sent, delivered, read, or failed. */
const reportSendStatus = (payload) => post('/api/whatsapp/send-status', payload);

/** Session heartbeat, so the portal can render connection health. */
const reportSession = (payload) => post('/api/whatsapp/session', payload);

module.exports = { post, reportApproval, logMessage, reportSendStatus, reportSession };
