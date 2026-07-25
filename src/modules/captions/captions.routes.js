/**
 * Captions module — permanent caption library, organised by month/client/
 * platform/campaign, with instant search (FULLTEXT + LIKE fallback).
 */
'use strict';

const express = require('express');
const { body, param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination, pick } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate);

/* GET /api/captions — search + filters */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 20);
    const conds = [];
    const params = [];

    if (req.user.role === 'client') {
      conds.push('cap.client_id = ?');
      params.push(req.user.clientId || 0);
    } else if (req.query.client_id) {
      conds.push('cap.client_id = ?');
      params.push(Number(req.query.client_id));
    }
    if (req.query.month) { conds.push('cap.month_key = ?'); params.push(req.query.month); }
    if (req.query.platform) { conds.push('cap.platform = ?'); params.push(req.query.platform); }
    if (req.query.campaign) { conds.push('cap.campaign = ?'); params.push(req.query.campaign); }
    if (req.query.q) {
      conds.push('(cap.body LIKE ? OR cap.hashtags LIKE ? OR cap.cta LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM captions cap ${where}`, params);
    const rows = await query(
      `SELECT cap.*, c.company_name, d.title AS deliverable_title
       FROM captions cap
       JOIN clients c ON c.id = cap.client_id
       LEFT JOIN deliverables d ON d.id = cap.deliverable_id
       ${where} ORDER BY cap.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* POST /api/captions — save a caption (admin) */
router.post(
  '/',
  requireAdmin,
  validate([
    body('client_id').isInt(),
    body('body').trim().isLength({ min: 2, max: 5000 }).withMessage('Caption body required'),
    body('deliverable_id').optional({ values: 'falsy' }).isInt(),
    body('platform').optional({ values: 'falsy' }).isLength({ max: 40 }),
    body('campaign').optional({ values: 'falsy' }).isLength({ max: 150 }),
    body('hashtags').optional({ values: 'falsy' }).isLength({ max: 2000 }),
    body('cta').optional({ values: 'falsy' }).isLength({ max: 500 }),
  ]),
  asyncHandler(async (req, res) => {
    const data = pick(req.body, ['client_id', 'deliverable_id', 'platform', 'campaign', 'body', 'hashtags', 'cta', 'hooks']);
    const client = await queryOne('SELECT id FROM clients WHERE id = ?', [data.client_id]);
    if (!client) throw ApiError.notFound('Client not found');

    let monthKey = new Date().toISOString().slice(0, 7);
    if (data.deliverable_id) {
      const d = await queryOne('SELECT month_key FROM deliverables WHERE id = ?', [data.deliverable_id]);
      if (d && d.month_key) monthKey = d.month_key;
    }
    const r = await query(
      `INSERT INTO captions (deliverable_id, client_id, platform, campaign, month_key, body, hashtags, cta, hooks, is_ai_generated, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        data.deliverable_id || null, data.client_id, data.platform || null, data.campaign || null,
        monthKey, data.body, data.hashtags || null, data.cta || null, data.hooks || null,
        req.body.is_ai_generated ? 1 : 0, req.user.id,
      ]
    );
    // Keep the deliverable's caption in sync if attached.
    if (data.deliverable_id) {
      await query('UPDATE deliverables SET caption = ? WHERE id = ?', [data.body, data.deliverable_id]);
    }
    audit(req, 'create', 'caption', r.insertId, 'Caption saved to library');
    ok(res, { id: r.insertId }, 'Caption saved', 201);
  })
);

/* PATCH /api/captions/:id */
router.patch(
  '/:id',
  requireAdmin,
  validate([param('id').isInt(), body('body').optional().trim().isLength({ min: 2, max: 5000 })]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cap = await queryOne('SELECT * FROM captions WHERE id = ?', [id]);
    if (!cap) throw ApiError.notFound('Caption not found');
    const data = pick(req.body, ['body', 'hashtags', 'cta', 'hooks', 'platform', 'campaign']);
    if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');
    const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
    await query(`UPDATE captions SET ${sets} WHERE id = ?`, [...Object.values(data), id]);
    if (data.body && cap.deliverable_id) {
      await query('UPDATE deliverables SET caption = ? WHERE id = ?', [data.body, cap.deliverable_id]);
    }
    ok(res, null, 'Caption updated');
  })
);

/* DELETE /api/captions/:id */
router.delete(
  '/:id',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    await query('DELETE FROM captions WHERE id = ?', [Number(req.params.id)]);
    ok(res, null, 'Caption deleted');
  })
);

module.exports = router;
