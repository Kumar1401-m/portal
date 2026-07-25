/**
 * Content library module — Script Library + Thumbnail Library.
 * Admins manage; clients can read their own.
 */
'use strict';

const express = require('express');
const { body, param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate);

/** Scope helper: clients only see their own rows. */
function scopeConds(req, alias = 't') {
  const conds = [];
  const params = [];
  if (req.user.role === 'client') {
    conds.push(`${alias}.client_id = ?`);
    params.push(req.user.clientId || 0);
  } else if (req.query.client_id) {
    conds.push(`${alias}.client_id = ?`);
    params.push(Number(req.query.client_id));
  }
  return { conds, params };
}

/* -------------------------------- SCRIPTS ------------------------------- */

/* GET /api/library/scripts */
router.get(
  '/scripts',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 12);
    const { conds, params } = scopeConds(req, 's');
    if (req.query.month) { conds.push('s.month_key = ?'); params.push(req.query.month); }
    if (req.query.q) { conds.push('(s.title LIKE ? OR s.body LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM scripts s ${where}`, params);
    const rows = await query(
      `SELECT s.*, c.company_name, d.title AS deliverable_title
       FROM scripts s JOIN clients c ON c.id = s.client_id
       LEFT JOIN deliverables d ON d.id = s.deliverable_id
       ${where} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* POST /api/library/scripts */
router.post(
  '/scripts',
  requireAdmin,
  validate([
    body('client_id').isInt(),
    body('title').trim().isLength({ min: 2, max: 255 }),
    body('body').trim().isLength({ min: 2 }),
    body('platform').optional({ values: 'falsy' }).isLength({ max: 40 }),
    body('campaign').optional({ values: 'falsy' }).isLength({ max: 150 }),
    body('deliverable_id').optional({ values: 'falsy' }).isInt(),
  ]),
  asyncHandler(async (req, res) => {
    const client = await queryOne('SELECT id FROM clients WHERE id = ?', [Number(req.body.client_id)]);
    if (!client) throw ApiError.notFound('Client not found');
    const monthKey = new Date().toISOString().slice(0, 7);
    const r = await query(
      `INSERT INTO scripts (client_id, deliverable_id, title, body, platform, campaign, month_key, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        req.body.client_id, req.body.deliverable_id || null, req.body.title, req.body.body,
        req.body.platform || null, req.body.campaign || null, monthKey, req.user.id,
      ]
    );
    audit(req, 'create', 'script', r.insertId, `Saved script "${req.body.title}"`);
    ok(res, { id: r.insertId }, 'Script saved', 201);
  })
);

/* PATCH /api/library/scripts/:id */
router.patch(
  '/scripts/:id',
  requireAdmin,
  validate([param('id').isInt(), body('title').optional().trim().isLength({ min: 2 }), body('body').optional().trim().isLength({ min: 2 })]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const s = await queryOne('SELECT id FROM scripts WHERE id = ?', [id]);
    if (!s) throw ApiError.notFound('Script not found');
    const fields = [];
    const params = [];
    ['title', 'body', 'platform', 'campaign'].forEach((k) => {
      if (req.body[k] !== undefined) { fields.push(`${k} = ?`); params.push(req.body[k]); }
    });
    if (!fields.length) throw ApiError.badRequest('Nothing to update');
    params.push(id);
    await query(`UPDATE scripts SET ${fields.join(', ')} WHERE id = ?`, params);
    ok(res, null, 'Script updated');
  })
);

/* DELETE /api/library/scripts/:id */
router.delete(
  '/scripts/:id',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    await query('DELETE FROM scripts WHERE id = ?', [Number(req.params.id)]);
    ok(res, null, 'Script deleted');
  })
);

/* ------------------------------ THUMBNAILS ------------------------------ */

/* GET /api/library/thumbnails */
router.get(
  '/thumbnails',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 16);
    const { conds, params } = scopeConds(req, 't');
    if (req.query.month) { conds.push('t.month_key = ?'); params.push(req.query.month); }
    if (req.query.q) { conds.push('t.title LIKE ?'); params.push(`%${req.query.q}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM thumbnails t ${where}`, params);
    const rows = await query(
      `SELECT t.*, c.company_name FROM thumbnails t JOIN clients c ON c.id = t.client_id
       ${where} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* POST /api/library/thumbnails */
router.post(
  '/thumbnails',
  requireAdmin,
  validate([
    body('client_id').isInt(),
    body('image_url').isURL().withMessage('Valid image URL required'),
    body('title').optional({ values: 'falsy' }).isLength({ max: 255 }),
    body('platform').optional({ values: 'falsy' }).isLength({ max: 40 }),
    body('deliverable_id').optional({ values: 'falsy' }).isInt(),
  ]),
  asyncHandler(async (req, res) => {
    const client = await queryOne('SELECT id FROM clients WHERE id = ?', [Number(req.body.client_id)]);
    if (!client) throw ApiError.notFound('Client not found');
    const r = await query(
      `INSERT INTO thumbnails (client_id, deliverable_id, title, image_url, platform, month_key, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [
        req.body.client_id, req.body.deliverable_id || null, req.body.title || null,
        req.body.image_url, req.body.platform || null, new Date().toISOString().slice(0, 7), req.user.id,
      ]
    );
    audit(req, 'create', 'thumbnail', r.insertId, 'Saved thumbnail');
    ok(res, { id: r.insertId }, 'Thumbnail saved', 201);
  })
);

/* DELETE /api/library/thumbnails/:id */
router.delete(
  '/thumbnails/:id',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    await query('DELETE FROM thumbnails WHERE id = ?', [Number(req.params.id)]);
    ok(res, null, 'Thumbnail deleted');
  })
);

module.exports = router;
