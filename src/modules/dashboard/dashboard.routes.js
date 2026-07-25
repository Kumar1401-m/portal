/**
 * Dashboard module — aggregated stats for the admin dashboard and the client
 * portal dashboard, plus recent activity feed.
 */
'use strict';

const express = require('express');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const { authenticate, requireAdmin } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticate);

/* GET /api/dashboard/admin — every admin dashboard number in one call */
router.get(
  '/admin',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [clients, deliverables, payments, approvals, activities, upcoming] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS total,
          SUM(status='active') AS active,
          SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_30d
         FROM clients WHERE status != 'churned'`
      ),
      queryOne(
        // Buckets are mutually exclusive so they reconcile:
        //   month_pending + month_completed + month_dropped = month_total
        // "done" = client-approved and everything after it in the pipeline.
        // "pending" = still in production / awaiting approval.
        `SELECT
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')) AS month_total,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status IN ('approved','scheduled','posted','completed')) AS month_completed,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status NOT IN ('approved','scheduled','posted','completed','cancelled','rejected')) AS month_pending,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status IN ('cancelled','rejected')) AS month_dropped,
          SUM(due_date = CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS today,
          SUM(due_date > CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS upcoming,
          SUM(due_date < CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS overdue
         FROM deliverables`
      ),
      queryOne(
        `SELECT
          COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending_amount,
          SUM(status='pending') AS pending_count,
          COALESCE(SUM(CASE WHEN status='paid'
            AND DATE_FORMAT(paid_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN amount END),0) AS month_received,
          COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) AS total_received
         FROM payments`
      ),
      queryOne(
        // Split so the dashboard can show them separately:
        //   awaiting  = on the client's desk (content or final review)
        //   changes   = client asked for changes — the ball is with the agency
        `SELECT
          COALESCE(SUM(status IN ('content_review','review')),0) AS awaiting,
          COALESCE(SUM(status = 'changes_requested'),0) AS changes
         FROM deliverables`
      ),
      query(
        `SELECT actor_name, action, entity_type, entity_id, description, created_at
         FROM activity_logs ORDER BY id DESC LIMIT 12`
      ),
      query(
        `SELECT d.id, d.title, d.due_date, d.status, d.platform, c.company_name
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         WHERE d.due_date >= CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')
         ORDER BY d.due_date ASC LIMIT 8`
      ),
    ]);

    // Client progress bars (current month completion per active client)
    const clientProgress = await query(
      `SELECT c.id, c.company_name, c.monthly_deliverables,
        COALESCE(SUM(d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m')),0) AS planned,
        COALESCE(SUM(d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m') AND d.status IN ('posted','completed')),0) AS completed
       FROM clients c
       LEFT JOIN deliverables d ON d.client_id = c.id
       WHERE c.status = 'active'
       GROUP BY c.id ORDER BY c.company_name LIMIT 10`
    );

    // Revenue by month (last 6 months) for the chart
    const revenue = await query(
      `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS month, COALESCE(SUM(amount),0) AS total
       FROM payments WHERE status='paid' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY month ORDER BY month`
    );
    // Deliverable status distribution for the chart
    const statusDist = await query(
      `SELECT status, COUNT(*) AS n FROM deliverables
       WHERE month_key = DATE_FORMAT(CURDATE(), '%Y-%m') GROUP BY status`
    );

    ok(res, {
      clients, deliverables, payments,
      pending_approvals: approvals.awaiting,
      changes_requested: approvals.changes,
      recent_activities: activities,
      upcoming_tasks: upcoming,
      client_progress: clientProgress,
      charts: { revenue, status_distribution: statusDist },
    });
  })
);

/* GET /api/dashboard/client — client portal dashboard */
router.get(
  '/client',
  asyncHandler(async (req, res) => {
    const clientId = req.user.role === 'client' ? req.user.clientId : Number(req.query.client_id);
    if (!clientId) return ok(res, null, 'No client profile linked');

    const [client, month, awaiting, payments, notifications] = await Promise.all([
      queryOne('SELECT id, company_name, company_logo_url, monthly_package, renewal_date, monthly_deliverables FROM clients WHERE id = ?', [clientId]),
      queryOne(
        `SELECT COUNT(*) AS planned,
          SUM(status='completed') AS completed,
          SUM(status IN ('posted','completed')) AS posted,
          SUM(status='waiting_for_raw') AS waiting_raw
         FROM deliverables WHERE client_id = ? AND month_key = DATE_FORMAT(CURDATE(), '%Y-%m')`,
        [clientId]
      ),
      query(
        `SELECT id, title, platform, due_date, status FROM deliverables
         WHERE client_id = ? AND approval_status='pending' AND status IN ('review','caption_ready')
         ORDER BY due_date ASC LIMIT 10`,
        [clientId]
      ),
      queryOne(
        `SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS due,
          COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) AS paid
         FROM payments WHERE client_id = ?`,
        [clientId]
      ),
      query(
        'SELECT id, type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 8',
        [req.user.id]
      ),
    ]);

    ok(res, { client, month, awaiting_approval: awaiting, payments, notifications });
  })
);

module.exports = router;
