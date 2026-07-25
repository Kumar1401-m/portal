/**
 * Notifications module — in-app notification center.
 */
'use strict';

const express = require('express');
const { param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination } = require('../../utils/helpers');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticate);

/* GET /api/notifications */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 15);
    const unreadOnly = req.query.unread === '1';
    const where = `WHERE user_id = ?${unreadOnly ? ' AND is_read = 0' : ''}`;
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM notifications ${where}`, [req.user.id]);
    const rows = await query(
      `SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
      [req.user.id]
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* GET /api/notifications/unread-count */
router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    ok(res, { count: row.n });
  })
);

/* POST /api/notifications/:id/read */
router.post(
  '/:id/read',
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    await query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [
      Number(req.params.id), req.user.id,
    ]);
    ok(res, null, 'Marked read');
  })
);

/* POST /api/notifications/read-all */
router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    ok(res, null, 'All notifications marked read');
  })
);

module.exports = router;
