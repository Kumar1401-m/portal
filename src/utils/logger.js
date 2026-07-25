/**
 * Tiny dependency-free logger with levels and timestamps.
 * Writes to console; in production you can pipe stdout to a file/collector.
 */
'use strict';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const current = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function stamp() {
  return new Date().toISOString();
}

function log(level, args) {
  if (levels[level] > levels[current]) return;
  const prefix = `[${stamp()}] [${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

module.exports = {
  error: (...a) => log('error', a),
  warn: (...a) => log('warn', a),
  info: (...a) => log('info', a),
  debug: (...a) => log('debug', a),
};
