/**
 * Central error handling: 404 fallthrough + JSON error responses.
 * Operational ApiErrors expose their message; unexpected errors are logged
 * and masked in production.
 */
'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details || null;

  // Common MySQL error translations
  if (err.code === 'ER_DUP_ENTRY') {
    status = 409;
    message = 'A record with that value already exists';
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} ->`, err.stack || err);
    if (env.isProd) {
      message = 'Internal server error';
      details = null;
    }
  }

  res.status(status).json({ success: false, message, details });
}

module.exports = { notFound, errorHandler };
