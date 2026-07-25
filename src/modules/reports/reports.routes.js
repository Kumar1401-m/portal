/**
 * Reports module — monthly / client / deliverables / promotion / payment /
 * performance reports as JSON (rendered by the UI) and CSV export (opens in
 * Excel). PDF export is produced client-side via the print-optimised report
 * view (browser "Save as PDF"), keeping the server dependency-free.
 */
'use strict';

const express = require('express');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate);

const monthOf = (req) =>
  /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);

/** Core report builder shared by JSON + CSV endpoints. */
async function buildReport(type, { month, clientId, user }) {
  // Clients may only pull their own reports.
  if (user.role === 'client') clientId = user.clientId;

  switch (type) {
    case 'monthly':
    case 'client': {
      const clientCond = clientId ? 'AND d.client_id = ?' : '';
      const params = clientId ? [month, clientId] : [month];
      const rows = await query(
        `SELECT c.company_name, d.title, d.platform, d.due_date, d.status,
                d.approval_status, d.posting_status, d.ai_score, d.reject_reason
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         WHERE d.month_key = ? ${clientCond}
         ORDER BY c.company_name, d.due_date`,
        params
      );
      const summary = {
        total: rows.length,
        completed: rows.filter((r) => r.status === 'completed').length,
        posted: rows.filter((r) => ['posted', 'completed'].includes(r.status)).length,
        rejected: rows.filter((r) => r.status === 'rejected').length,
        avg_ai_score: rows.length
          ? Math.round(rows.reduce((s, r) => s + (r.ai_score || 0), 0) /
              Math.max(rows.filter((r) => r.ai_score).length, 1))
          : 0,
      };
      return { title: `${type === 'client' ? 'Client' : 'Monthly'} Report — ${month}`, summary, rows };
    }

    case 'deliverables': {
      const rows = await query(
        `SELECT c.company_name, d.title, d.platform, d.due_date, d.priority, d.status,
                d.raw_drive_link, d.edited_link, d.ai_score
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         ${clientId ? 'WHERE d.client_id = ?' : ''}
         ORDER BY d.due_date DESC LIMIT 500`,
        clientId ? [clientId] : []
      );
      return { title: 'Deliverables Report', summary: { total: rows.length }, rows };
    }

    case 'promotion': {
      const clientCond = clientId ? 'AND d.client_id = ?' : '';
      const params = clientId ? [month, clientId] : [month];
      const rows = await query(
        `SELECT c.company_name, d.title, d.platform, d.posting_status, d.posted_at, d.reject_reason
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         WHERE d.month_key = ? ${clientCond}
         ORDER BY d.posting_status, d.posted_at DESC`,
        params
      );
      const summary = {
        posted: rows.filter((r) => r.posting_status === 'posted').length,
        not_posted: rows.filter((r) => r.posting_status === 'not_posted').length,
        scheduled: rows.filter((r) => r.posting_status === 'scheduled').length,
        rejected: rows.filter((r) => r.posting_status === 'rejected').length,
      };
      return { title: `Promotion Report — ${month}`, summary, rows };
    }

    case 'payment': {
      const clientCond = clientId ? 'WHERE p.client_id = ?' : '';
      const rows = await query(
        `SELECT c.company_name, i.invoice_no, p.amount, p.status, p.method, p.paid_at, i.due_date
         FROM payments p
         LEFT JOIN invoices i ON i.id = p.invoice_id
         JOIN clients c ON c.id = p.client_id
         ${clientCond} ORDER BY p.created_at DESC LIMIT 500`,
        clientId ? [clientId] : []
      );
      const summary = {
        received: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + Number(r.amount), 0),
        pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + Number(r.amount), 0),
      };
      return { title: 'Payment Report', summary, rows };
    }

    case 'performance': {
      const clientCond = clientId ? 'AND s.client_id = ?' : '';
      const params = clientId ? [clientId] : [];
      const rows = await query(
        `SELECT c.company_name, s.snapshot_date, s.followers, s.reach, s.impressions,
                s.likes, s.comments, s.shares, s.saves, s.engagement_rate
         FROM analytics_snapshots s JOIN clients c ON c.id = s.client_id
         WHERE s.snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${clientCond}
         ORDER BY c.company_name, s.snapshot_date DESC LIMIT 1000`,
        params
      );
      return { title: 'Performance Report (30 days)', summary: { rows: rows.length }, rows };
    }

    default:
      throw ApiError.badRequest('Unknown report type');
  }
}

/* GET /api/reports/:type — JSON payload for the report viewer */
router.get(
  '/:type',
  asyncHandler(async (req, res) => {
    const report = await buildReport(req.params.type, {
      month: monthOf(req),
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
      user: req.user,
    });
    ok(res, report);
  })
);

/* GET /api/reports/:type/csv — Excel-compatible CSV download */
router.get(
  '/:type/csv',
  asyncHandler(async (req, res) => {
    const report = await buildReport(req.params.type, {
      month: monthOf(req),
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
      user: req.user,
    });
    const rows = report.rows || [];
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
    ].join('\r\n');

    if (req.user.role !== 'client') {
      audit(req, 'export', 'report', null, `Exported ${req.params.type} report (CSV)`);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.params.type}-report-${monthOf(req)}.csv"`
    );
    res.send('﻿' + csv); // BOM so Excel opens UTF-8 correctly
  })
);

module.exports = router;
