/**
 * Activity logs (audit trail) viewer — admins only.
 */
'use strict';

const express = require('express');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, paginated, getPagination } = require('../../utils/helpers');
const { authenticate, requireAdmin } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

/* GET /api/activity */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 30);
    const conds = [];
    const params = [];
    if (req.query.entity_type) { conds.push('entity_type = ?'); params.push(req.query.entity_type); }
    if (req.query.entity_id) { conds.push('entity_id = ?'); params.push(Number(req.query.entity_id)); }
    if (req.query.user_id) { conds.push('user_id = ?'); params.push(Number(req.query.user_id)); }
    if (req.query.q) { conds.push('(description LIKE ? OR action LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM activity_logs ${where}`, params);
    const rows = await query(
      `SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

module.exports = router;
