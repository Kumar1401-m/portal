'use strict';

/**
 * Configuration for the WhatsApp approval service.
 *
 * Every secret comes from the environment; nothing is ever committed. The
 * process refuses to start when a genuinely required value is missing, because
 * a service that boots and then silently fails every send is far harder to
 * diagnose than one that won't start.
 */
require('dotenv').config();

const int = (v, fallback) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback = false) =>
  v == null || v === '' ? fallback : String(v).toLowerCase() === 'true';

const config = {
  port: int(process.env.PORT, 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  portal: {
    /** Base URL of the Next.js portal, no trailing slash. */
    url: (process.env.PORTAL_URL || '').replace(/\/+$/, ''),
    /** Shared secret; must equal WHATSAPP_SERVICE_KEY in the portal. */
    apiKey: process.env.PORTAL_API_KEY || '',
    /** How long to wait on a portal callback before treating it as failed. */
    timeoutMs: int(process.env.PORTAL_TIMEOUT_MS, 20000),
  },

  /** Who may call THIS service. The portal sends this as a bearer token. */
  serviceKey: process.env.SERVICE_API_KEY || '',

  whatsapp: {
    /**
     * Where LocalAuth keeps the logged-in session. Must be a persistent
     * volume in Docker — losing it means re-scanning the QR code, and in
     * production that is downtime nobody notices until an approval goes
     * unanswered.
     */
    sessionPath: process.env.WA_SESSION_PATH || './.wwebjs_auth',
    clientId: process.env.WA_CLIENT_ID || 'agency-approvals',
    /** Chromium binary. Set in Docker; left blank Puppeteer uses its bundled one. */
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: bool(process.env.WA_HEADLESS, true),
    /**
     * Only these groups are listened to when set (comma-separated ids).
     * Empty means "every group", which is the normal configuration — the
     * portal decides what it recognises.
     */
    allowedGroups: (process.env.WA_ALLOWED_GROUPS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  send: {
    /** Retry budget for one video send. */
    maxAttempts: int(process.env.SEND_MAX_ATTEMPTS, 3),
    /** Base backoff; doubles each attempt. */
    retryDelayMs: int(process.env.SEND_RETRY_DELAY_MS, 15000),
    /**
     * WhatsApp rejects very large media. 16 MB is the practical ceiling for a
     * video sent as a document-free media message; above that the send fails
     * with an unhelpful error, so it's caught here instead.
     */
    maxMediaBytes: int(process.env.SEND_MAX_MEDIA_BYTES, 16 * 1024 * 1024),
    /** Gap between consecutive sends — WhatsApp rate-limits aggressively. */
    throttleMs: int(process.env.SEND_THROTTLE_MS, 3000),
  },

  /** Browser origins allowed to open a Socket.IO connection. */
  corsOrigins: (process.env.CORS_ORIGINS || process.env.PORTAL_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  logLevel: process.env.LOG_LEVEL || 'info',
};

/** Fail fast, and say exactly which variable is missing. */
function assertConfig() {
  const missing = [];
  if (!config.portal.url) missing.push('PORTAL_URL');
  if (!config.portal.apiKey) missing.push('PORTAL_API_KEY');
  if (!config.serviceKey) missing.push('SERVICE_API_KEY');

  if (missing.length) {
    console.error(
      `\nRefusing to start — missing required environment variables:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\n\nCopy .env.example to .env and fill them in.\n`
    );
    process.exit(1);
  }

  if (config.isProd && config.serviceKey.length < 24) {
    console.error('\nSERVICE_API_KEY is too short for production (use 32+ random chars).\n');
    process.exit(1);
  }
}

module.exports = { config, assertConfig };
