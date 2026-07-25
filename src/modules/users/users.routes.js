/**
 * Users module (team management). Super admin manages admins; admins can view.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');

const env = require('../../config/env');
const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate);

/* GET /api/users — list team users (admins only) */
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const role = req.query.role;
    const where = role ? 'WHERE role = ?' : "WHERE role IN ('admin','super_admin','poster_designer')";
    const params = role ? [role] : [];
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM users ${where}`, params);
    const rows = await query(
      `SELECT id, name, email, role, phone, is_active, last_login_at, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* POST /api/users — create team member (super admin) */
router.post(
  '/',
  requireSuperAdmin,
  validate([
    body('name').trim().isLength({ min: 2 }).escape(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).matches(/[A-Za-z]/).matches(/\d/)
      .withMessage('Min 8 chars with letters and numbers'),
    body('role').isIn(['admin', 'super_admin', 'poster_designer']),
    body('phone').optional({ values: 'falsy' }).trim().isLength({ max: 30 }),
  ]),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, phone = null } = req.body;
    const hash = await bcrypt.hash(password, env.bcryptRounds);
    const result = await query(
      'INSERT INTO users (name, email, password_hash, role, phone) VALUES (?,?,?,?,?)',
      [name, email, hash, role, phone]
    );
    audit(req, 'create', 'user', result.insertId, `Created ${role} "${name}"`);
    ok(res, { id: result.insertId }, 'User created', 201);
  })
);

/* PATCH /api/users/:id — update (super admin) */
router.patch(
  '/:id',
  requireSuperAdmin,
  validate([
    param('id').isInt(),
    body('name').optional().trim().isLength({ min: 2 }).escape(),
    body('phone').optional({ values: 'falsy' }).trim().isLength({ max: 30 }),
    body('role').optional().isIn(['admin', 'super_admin', 'poster_designer']),
    body('is_active').optional().isBoolean(),
    body('password').optional().isLength({ min: 8 }).matches(/[A-Za-z]/).matches(/\d/),
  ]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) throw ApiError.notFound('User not found');
    if (user.role === 'client') throw ApiError.badRequest('Manage client logins from the Clients module');

    const fields = [];
    const params = [];
    for (const key of ['name', 'phone', 'role']) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }
    if (req.body.is_active !== undefined) {
      if (id === req.user.id && !req.body.is_active) throw ApiError.badRequest('You cannot disable yourself');
      fields.push('is_active = ?');
      params.push(req.body.is_active ? 1 : 0);
    }
    if (req.body.password) {
      fields.push('password_hash = ?');
      params.push(await bcrypt.hash(req.body.password, env.bcryptRounds));
    }
    if (!fields.length) throw ApiError.badRequest('Nothing to update');
    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
    audit(req, 'update', 'user', id, `Updated user #${id}`);
    ok(res, null, 'User updated');
  })
);

/* DELETE /api/users/:id — deactivate (soft) */
router.delete(
  '/:id',
  requireSuperAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw ApiError.badRequest('You cannot delete yourself');
    await query('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [id]);
    audit(req, 'deactivate', 'user', id, `Deactivated user #${id}`);
    ok(res, null, 'User deactivated');
  })
);

module.exports = router;
