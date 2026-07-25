/**
 * JWT authentication + role-based access control middleware.
 */
'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { queryOne } = require('../config/db');

/**
 * Require a valid access token. Attaches `req.user = {id, role, name, email, clientId}`.
 * Token is read from the Authorization: Bearer header (primary) or `token` cookie.
 */
async function authenticate(req, res, next) {
  try {
    let token = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
    if (!token && req.cookies && req.cookies.token) token = req.cookies.token;
    if (!token) throw ApiError.unauthorized('Authentication required');

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret);
    } catch (e) {
      throw ApiError.unauthorized(e.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token');
    }

    // Confirm the account still exists and is active (revocation safety).
    const user = await queryOne(
      'SELECT id, name, email, role, is_active FROM users WHERE id = ?',
      [payload.sub]
    );
    if (!user || !user.is_active) throw ApiError.unauthorized('Account disabled');

    req.user = { id: user.id, name: user.name, email: user.email, role: user.role, clientId: null };

    // For client users, resolve their client record once per request.
    if (user.role === 'client') {
      const client = await queryOne('SELECT id FROM clients WHERE user_id = ?', [user.id]);
      req.user.clientId = client ? client.id : null;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Restrict a route to specific roles.
 * Usage: router.get('/', authenticate, requireRole('admin', 'super_admin'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden('Insufficient permissions'));
    next();
  };
}

/** Shorthand: admin or super admin. */
const requireAdmin = requireRole('admin', 'super_admin');
/** Shorthand: super admin only. */
const requireSuperAdmin = requireRole('super_admin');

/**
 * For client users, force queries to be scoped to their own client record.
 * Admins may pass ?client_id=; clients always get their own.
 */
function scopeClient(req) {
  if (req.user.role === 'client') return req.user.clientId;
  const q = req.query.client_id || req.body.client_id;
  return q ? Number(q) : null;
}

module.exports = { authenticate, requireRole, requireAdmin, requireSuperAdmin, scopeClient };
