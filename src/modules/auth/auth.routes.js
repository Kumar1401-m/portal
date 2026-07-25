/**
 * Auth module: login, refresh, logout, me, forgot/reset password.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');

const env = require('../../config/env');
const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const { sendEmail } = require('../../services/emailService');

const router = express.Router();

// Brute-force protection on credential endpoints.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, try again later.' },
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function signAccess(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
  });
}

async function issueRefresh(user, req, remember) {
  const token = jwt.sign({ sub: user.id, type: 'refresh' }, env.jwt.refreshSecret, {
    expiresIn: remember ? '30d' : env.jwt.refreshExpires,
  });
  const decoded = jwt.decode(token);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES (?,?,FROM_UNIXTIME(?),?,?)`,
    [user.id, sha256(token), decoded.exp, (req.headers['user-agent'] || '').slice(0, 250), req.ip]
  );
  return token;
}

/* POST /api/auth/login */
router.post(
  '/login',
  loginLimiter,
  validate([
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
    body('password').isString().isLength({ min: 6 }).withMessage('Password required (min 6 chars)'),
    body('remember').optional().isBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const { email, password, remember = false } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw ApiError.unauthorized('Invalid email or password');
    }
    if (!user.is_active) throw ApiError.forbidden('Your account is disabled. Contact the agency.');

    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const accessToken = signAccess(user);
    const refreshToken = await issueRefresh(user, req, remember);

    let clientId = null;
    if (user.role === 'client') {
      const client = await queryOne('SELECT id, company_name FROM clients WHERE user_id = ?', [user.id]);
      clientId = client ? client.id : null;
    }

    req.user = { id: user.id, name: user.name };
    audit(req, 'login', 'user', user.id, `${user.name} logged in`);

    ok(res, {
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, clientId },
    }, 'Login successful');
  })
);

/* POST /api/auth/refresh */
router.post(
  '/refresh',
  validate([body('refreshToken').isString().notEmpty()]),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    let payload;
    try {
      payload = jwt.verify(refreshToken, env.jwt.refreshSecret);
    } catch {
      throw ApiError.unauthorized('Invalid refresh token');
    }
    const row = await queryOne(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()',
      [sha256(refreshToken)]
    );
    if (!row) throw ApiError.unauthorized('Refresh token revoked or expired');

    const user = await queryOne('SELECT * FROM users WHERE id = ? AND is_active = 1', [payload.sub]);
    if (!user) throw ApiError.unauthorized('Account not found');

    ok(res, { accessToken: signAccess(user) }, 'Token refreshed');
  })
);

/* POST /api/auth/logout — revoke the presented refresh token */
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?', [
        sha256(refreshToken),
      ]);
    }
    ok(res, null, 'Logged out');
  })
);

/* GET /api/auth/me */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    let company = null;
    if (req.user.role === 'client' && req.user.clientId) {
      const c = await queryOne('SELECT company_name, company_logo_url FROM clients WHERE id = ?', [
        req.user.clientId,
      ]);
      company = c || null;
    }
    ok(res, { ...req.user, company });
  })
);

/* POST /api/auth/forgot-password */
router.post(
  '/forgot-password',
  loginLimiter,
  validate([body('email').isEmail().normalizeEmail()]),
  asyncHandler(async (req, res) => {
    const user = await queryOne('SELECT id, name, email FROM users WHERE email = ?', [req.body.email]);
    // Always respond success to avoid account enumeration.
    if (user) {
      const raw = crypto.randomBytes(32).toString('hex');
      await query(
        'UPDATE users SET reset_token = ?, reset_expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
        [sha256(raw), user.id]
      );
      const link = `${env.appUrl}/reset-password.html?token=${raw}`;
      await sendEmail(
        user.email,
        'Password reset',
        'Reset your password',
        `<p>Hi ${user.name},</p><p>Click below to reset your password (valid 1 hour):</p>
         <p><a href="${link}" style="background:#4527a0;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reset Password</a></p>
         <p>If you didn't request this, you can ignore this email.</p>`
      );
    }
    ok(res, null, 'If that email exists, a reset link has been sent.');
  })
);

/* POST /api/auth/reset-password */
router.post(
  '/reset-password',
  loginLimiter,
  validate([
    body('token').isString().isLength({ min: 32 }),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
      .matches(/\d/).withMessage('Password must contain a number'),
  ]),
  asyncHandler(async (req, res) => {
    const user = await queryOne(
      'SELECT id FROM users WHERE reset_token = ? AND reset_expires_at > NOW()',
      [sha256(req.body.token)]
    );
    if (!user) throw ApiError.badRequest('Reset link is invalid or expired');
    const hash = await bcrypt.hash(req.body.password, env.bcryptRounds);
    await query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?',
      [hash, user.id]
    );
    // Revoke all refresh tokens after a password change.
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [user.id]);
    ok(res, null, 'Password updated. Please log in.');
  })
);

/* POST /api/auth/change-password (logged-in) */
router.post(
  '/change-password',
  authenticate,
  validate([
    body('currentPassword').isString().notEmpty(),
    body('newPassword').isLength({ min: 8 }).matches(/[A-Za-z]/).matches(/\d/)
      .withMessage('Min 8 chars with letters and numbers'),
  ]),
  asyncHandler(async (req, res) => {
    const user = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(req.body.currentPassword, user.password_hash))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
    const hash = await bcrypt.hash(req.body.newPassword, env.bcryptRounds);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    audit(req, 'change_password', 'user', req.user.id, 'Password changed');
    ok(res, null, 'Password changed');
  })
);

module.exports = router;
