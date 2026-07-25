/**
 * Global search — one query across clients, deliverables, captions, payments.
 */
'use strict';

const express = require('express');

const { query } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticate);

/* GET /api/search?q= */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return ok(res, { clients: [], deliverables: [], captions: [], payments: [] });
    const like = `%${q}%`;
    const isClient = req.user.role === 'client';
    const cid = req.user.clientId || 0;

    const [clients, deliverables, captions, payments] = await Promise.all([
      isClient
        ? Promise.resolve([])
        : query(
            `SELECT id, company_name, contact_person, status FROM clients
             WHERE company_name LIKE ? OR contact_person LIKE ? OR email LIKE ? LIMIT 8`,
            [like, like, like]
          ),
      query(
        `SELECT d.id, d.title, d.platform, d.status, d.due_date, c.company_name
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         WHERE (d.title LIKE ? OR d.caption LIKE ? OR d.campaign LIKE ?)
         ${isClient ? 'AND d.client_id = ?' : ''}
         ORDER BY d.due_date DESC LIMIT 10`,
        isClient ? [like, like, like, cid] : [like, like, like]
      ),
      query(
        `SELECT cap.id, cap.body, cap.platform, cap.month_key, c.company_name
         FROM captions cap JOIN clients c ON c.id = cap.client_id
         WHERE (cap.body LIKE ? OR cap.hashtags LIKE ?)
         ${isClient ? 'AND cap.client_id = ?' : ''}
         ORDER BY cap.id DESC LIMIT 8`,
        isClient ? [like, like, cid] : [like, like]
      ),
      query(
        `SELECT p.id, p.amount, p.status, i.invoice_no, c.company_name
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
         JOIN clients c ON c.id = p.client_id
         WHERE (i.invoice_no LIKE ? OR c.company_name LIKE ?)
         ${isClient ? 'AND p.client_id = ?' : ''}
         ORDER BY p.id DESC LIMIT 8`,
        isClient ? [like, like, cid] : [like, like]
      ),
    ]);

    ok(res, { clients, deliverables, captions, payments });
  })
);

module.exports = router;
