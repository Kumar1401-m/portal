'use strict';

/**
 * Structured logging.
 *
 * JSON lines in production so a log shipper can parse them; readable text in
 * development so a human can. No dependency — this service already pulls in
 * Puppeteer, and a logging library would be the least of its weight.
 *
 * Every log carries a `scope` so the three concurrent concerns (the WhatsApp
 * client, the HTTP API, the send queue) can be told apart in one stream.
 */
const { config } = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** Values that must never reach a log line, however convenient. */
const REDACT = /(?:api[_-]?key|token|secret|password|authorization)/i;

function redact(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

function emit(level, scope, message, meta) {
  if ((LEVELS[level] ?? 2) > threshold) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta: redact(meta) } : {}),
  };

  if (config.isProd) {
    console.log(JSON.stringify(entry));
    return;
  }

  const tint = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' }[level];
  const detail = meta ? ` ${JSON.stringify(redact(meta))}` : '';
  console.log(
    `${tint}${level.toUpperCase().padEnd(5)}\x1b[0m [${scope}] ${message}${detail}`
  );
}

/** A logger bound to one scope, so call sites don't repeat it. */
function createLogger(scope) {
  return {
    error: (m, meta) => emit('error', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    debug: (m, meta) => emit('debug', scope, m, meta),
  };
}

module.exports = { createLogger };
