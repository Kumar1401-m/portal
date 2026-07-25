/**
 * Clients module (CRM): CRUD + portal login provisioning + progress stats.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');

const env = require('../../config/env');
const { query, queryOne, transaction } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination, pick } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const { sendOnboardingEmail } = require('../../services/emailService');

const router = express.Router();
router.use(authenticate);

const CLIENT_FIELDS = [
  'company_name', 'company_logo_url', 'footer_watermark_url', 'contact_person', 'phone', 'email',
  'business_type', 'instagram_link', 'facebook_link', 'youtube_link', 'website',
  'monthly_package', 'package_amount', 'joining_date', 'renewal_date', 'monthly_deliverables',
  'payment_plan', 'notes', 'status', 'ig_user_id', 'fb_page_id', 'youtube_channel_id',
  'designer_id',
];

const clientValidators = (isCreate) => [
  body('company_name')[isCreate ? 'exists' : 'optional']().trim().isLength({ min: 2, max: 190 })
    .withMessage('Company name required'),
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('phone').optional({ values: 'falsy' }).trim().isLength({ max: 30 }),
  body('instagram_link').optional({ values: 'falsy' }).isURL().withMessage('Invalid Instagram URL'),
  body('facebook_link').optional({ values: 'falsy' }).isURL().withMessage('Invalid Facebook URL'),
  body('youtube_link').optional({ values: 'falsy' }).isURL().withMessage('Invalid YouTube URL'),
  body('company_logo_url').optional({ values: 'falsy' }).isURL().withMessage('Invalid logo URL'),
  body('footer_watermark_url').optional({ values: 'falsy' }).isURL().withMessage('Invalid watermark URL'),
  body('website').optional({ values: 'falsy' }).isURL().withMessage('Invalid website URL'),
  body('package_amount').optional().isFloat({ min: 0 }),
  body('monthly_deliverables').optional().isInt({ min: 0, max: 1000 }),
  body('payment_plan').optional().isIn(['monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time']),
  body('status').optional().isIn(['active', 'inactive', 'paused', 'churned']),
  body('joining_date').optional({ values: 'falsy' }).isDate(),
  body('renewal_date').optional({ values: 'falsy' }).isDate(),
  body('designer_id').optional({ values: 'falsy' }).isInt(),
];

/* GET /api/clients — list w/ search, filter, pagination */
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const conds = [];
    const params = [];
    // Archived (churned) clients are hidden by default; pass ?status=churned to see them.
    if (req.query.status) { conds.push('c.status = ?'); params.push(req.query.status); }
    else { conds.push("c.status != 'churned'"); }
    if (req.query.q) {
      conds.push('(c.company_name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM clients c ${where}`, params);
    const rows = await query(
      `SELECT c.*, u.email AS login_email, u.is_active AS login_active,
        (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id
          AND d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m')) AS month_total,
        (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id
          AND d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m') AND d.status = 'completed') AS month_done
       FROM clients c LEFT JOIN users u ON u.id = c.user_id
       ${where} ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* GET /api/clients/scorecard?month=YYYY-MM — monthly per-client content scorecard.
 * YouTube Videos = youtube platforms; Educational Reels = instagram reels.
 * Approved = content that has passed client approval (approved/scheduled/posted/completed). */
router.get(
  '/scorecard',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const rows = await query(
      `SELECT c.id, c.company_name, c.monthly_deliverables,
        COALESCE(COUNT(d.id),0) AS total,
        COALESCE(SUM(d.status IN ('approved','scheduled','posted','completed')),0) AS approved
       FROM clients c
       LEFT JOIN deliverables d ON d.client_id = c.id AND d.month_key = ?
       WHERE c.status != 'churned'
       GROUP BY c.id ORDER BY c.company_name`,
      [month]
    );
    ok(res, { month, clients: rows });
  })
);

/* GET /api/clients/:id — detail (admin, or the client itself) */
router.get(
  '/:id',
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (req.user.role === 'client' && req.user.clientId !== id) throw ApiError.forbidden();
    const client = await queryOne(
      `SELECT c.*, u.email AS login_email, u.is_active AS login_active
       FROM clients c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [id]
    );
    if (!client) throw ApiError.notFound('Client not found');

    const progress = await queryOne(
      `SELECT COUNT(*) AS total,
        SUM(status = 'completed') AS completed,
        SUM(status IN ('posted','completed')) AS posted,
        SUM(approval_status = 'pending' AND status IN ('review','caption_ready')) AS awaiting_approval
       FROM deliverables WHERE client_id = ? AND month_key = DATE_FORMAT(CURDATE(), '%Y-%m')`,
      [id]
    );
    ok(res, { ...client, progress });
  })
);

/* POST /api/clients — create (+ optional portal login) */
router.post(
  '/',
  requireAdmin,
  validate([
    ...clientValidators(true),
    body('portal_password').optional({ values: 'falsy' }).isLength({ min: 8 })
      .withMessage('Portal password: min 8 characters'),
  ]),
  asyncHandler(async (req, res) => {
    const data = pick(req.body, CLIENT_FIELDS);
    const { portal_password } = req.body;

    const result = await transaction(async (conn) => {
      let userId = null;
      if (portal_password) {
        if (!data.email) throw ApiError.badRequest('Client email required to create portal login');
        const hash = await bcrypt.hash(portal_password, env.bcryptRounds);
        const [u] = await conn.execute(
          'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
          [data.contact_person || data.company_name, data.email, hash, 'client']
        );
        userId = u.insertId;
      }
      const cols = Object.keys(data);
      const placeholders = cols.map(() => '?').join(',');
      const [c] = await conn.execute(
        `INSERT INTO clients (${cols.join(',')}, user_id, created_by) VALUES (${placeholders},?,?)`,
        [...cols.map((k) => data[k] === '' ? null : data[k]), userId, req.user.id]
      );
      return { clientId: c.insertId, userId };
    });

    audit(req, 'create', 'client', result.clientId, `Added client "${data.company_name}"`);
    // Formal onboarding email — includes portal credentials when a login was created.
    if (data.email) {
      sendOnboardingEmail(data, { password: portal_password || null }).catch(() => {});
    }
    ok(res, result, 'Client created', 201);
  })
);

/* PATCH /api/clients/:id */
router.patch(
  '/:id',
  requireAdmin,
  validate([param('id').isInt(), ...clientValidators(false)]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await queryOne('SELECT id FROM clients WHERE id = ?', [id]);
    if (!existing) throw ApiError.notFound('Client not found');

    const data = pick(req.body, CLIENT_FIELDS);
    if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');
    const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
    await query(`UPDATE clients SET ${sets} WHERE id = ?`, [
      ...Object.keys(data).map((k) => (data[k] === '' ? null : data[k])), id,
    ]);

    // Designer changed at client level → move this client's not-yet-finished tasks
    // to the new designer, so assignment stays at the client (not per task).
    if ('designer_id' in data) {
      const designerId = data.designer_id === '' ? null : data.designer_id;
      await query(
        `UPDATE deliverables SET assigned_to = ?
         WHERE client_id = ? AND status NOT IN ('posted','completed','cancelled','rejected')`,
        [designerId, id]
      );
    }
    audit(req, 'update', 'client', id, `Updated client #${id}`);
    ok(res, null, 'Client updated');
  })
);

/* POST /api/clients/:id/portal-login — create or reset the portal login */
router.post(
  '/:id/portal-login',
  requireAdmin,
  validate([
    param('id').isInt(),
    body('password').isLength({ min: 8 }).matches(/[A-Za-z]/).matches(/\d/)
      .withMessage('Min 8 chars with letters and numbers'),
  ]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const client = await queryOne('SELECT * FROM clients WHERE id = ?', [id]);
    if (!client) throw ApiError.notFound('Client not found');
    if (!client.email) throw ApiError.badRequest('Set the client email first');

    const hash = await bcrypt.hash(req.body.password, env.bcryptRounds);
    if (client.user_id) {
      await query('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?', [hash, client.user_id]);
      await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [client.user_id]);
    } else {
      const u = await query(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
        [client.contact_person || client.company_name, client.email, hash, 'client']
      );
      await query('UPDATE clients SET user_id = ? WHERE id = ?', [u.insertId, id]);
    }
    audit(req, 'portal_login', 'client', id, `Portal login provisioned for "${client.company_name}"`);
    ok(res, null, 'Portal login ready');
  })
);

/* GET /api/clients/:id/caption-config — AI caption settings/template/placeholders */
router.get(
  '/:id/caption-config',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const c = await queryOne(
      'SELECT caption_settings, placeholder_values, caption_template FROM clients WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!c) throw ApiError.notFound('Client not found');
    const parse = (v) => (v && typeof v === 'string' ? JSON.parse(v) : v) || {};
    ok(res, {
      caption_settings: parse(c.caption_settings),
      placeholder_values: parse(c.placeholder_values),
      caption_template: c.caption_template || '',
    });
  })
);

/* PUT /api/clients/:id/caption-config — save AI caption settings */
router.put(
  '/:id/caption-config',
  requireAdmin,
  validate([
    param('id').isInt(),
    body('caption_settings').optional().isObject(),
    body('placeholder_values').optional().isObject(),
    body('caption_template').optional({ values: 'falsy' }).isLength({ max: 5000 }),
  ]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const client = await queryOne('SELECT id FROM clients WHERE id = ?', [id]);
    if (!client) throw ApiError.notFound('Client not found');
    await query(
      'UPDATE clients SET caption_settings = ?, placeholder_values = ?, caption_template = ? WHERE id = ?',
      [
        JSON.stringify(req.body.caption_settings || {}),
        JSON.stringify(req.body.placeholder_values || {}),
        req.body.caption_template || null,
        id,
      ]
    );
    audit(req, 'update', 'client', id, 'Updated AI caption settings');
    ok(res, null, 'Caption settings saved');
  })
);

/* DELETE /api/clients/:id — archive (soft delete to churned) */
router.delete(
  '/:id',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const client = await queryOne('SELECT user_id, company_name FROM clients WHERE id = ?', [id]);
    if (!client) throw ApiError.notFound('Client not found');
    await query("UPDATE clients SET status = 'churned' WHERE id = ?", [id]);
    if (client.user_id) {
      await query('UPDATE users SET is_active = 0 WHERE id = ?', [client.user_id]);
    }
    audit(req, 'archive', 'client', id, `Archived client "${client.company_name}"`);
    ok(res, null, 'Client archived');
  })
);

module.exports = router;
