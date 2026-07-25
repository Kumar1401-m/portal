/**
 * Analytics module — Meta Graph metrics, growth series, comparisons.
 */
'use strict';

const express = require('express');
const { param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const metaService = require('../../services/metaService');
const youtubeService = require('../../services/youtubeService');
const aiService = require('../../services/aiService');

const router = express.Router();
router.use(authenticate);

function resolveClientId(req) {
  if (req.user.role === 'client') return req.user.clientId;
  return req.query.client_id ? Number(req.query.client_id) : null;
}

/* GET /api/analytics/overview?client_id=&days=30 */
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const clientId = resolveClientId(req);
    if (!clientId) throw ApiError.badRequest('client_id required');
    if (req.user.role === 'client' && req.user.clientId !== clientId) throw ApiError.forbidden();

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
    const platform = ['instagram', 'youtube'].includes(req.query.platform) ? req.query.platform : 'instagram';
    const data = await metaService.getClientAnalytics(clientId, days, platform);
    const best = await metaService.getBestContent(clientId, 5);

    // Week/month comparisons on the "reach" metric (0 for platforms without it).
    const cmp = await queryOne(
      `SELECT
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots
          WHERE client_id=? AND platform=? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) AS week_reach,
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots
          WHERE client_id=? AND platform=? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
            AND snapshot_date < DATE_SUB(CURDATE(), INTERVAL 7 DAY)) AS prev_week_reach,
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots
          WHERE client_id=? AND platform=? AND DATE_FORMAT(snapshot_date,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')) AS month_reach,
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots
          WHERE client_id=? AND platform=? AND DATE_FORMAT(snapshot_date,'%Y-%m') = DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH),'%Y-%m')) AS prev_month_reach`,
      [clientId, platform, clientId, platform, clientId, platform, clientId, platform]
    );
    const pct = (cur, prev) => (prev > 0 ? Number((((cur - prev) / prev) * 100).toFixed(1)) : null);

    ok(res, {
      ...data,
      platform,
      best_content: best,
      comparisons: {
        weekly: { current: Number(cmp.week_reach), previous: Number(cmp.prev_week_reach), change_pct: pct(cmp.week_reach, cmp.prev_week_reach) },
        monthly: { current: Number(cmp.month_reach), previous: Number(cmp.prev_month_reach), change_pct: pct(cmp.month_reach, cmp.prev_month_reach) },
      },
    });
  })
);

/* GET /api/analytics/insights?client_id= — AI growth insights */
router.get(
  '/insights',
  asyncHandler(async (req, res) => {
    const clientId = resolveClientId(req);
    if (!clientId) throw ApiError.badRequest('client_id required');
    if (req.user.role === 'client' && req.user.clientId !== clientId) throw ApiError.forbidden();

    const client = await queryOne('SELECT company_name FROM clients WHERE id = ?', [clientId]);
    if (!client) throw ApiError.notFound('Client not found');

    const latest = await queryOne(
      `SELECT followers, engagement_rate,
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots s2
          WHERE s2.client_id = ? AND s2.snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS reach
       FROM analytics_snapshots s WHERE s.client_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
      [clientId, clientId]
    );
    const platforms = await query(
      `SELECT platform, COUNT(*) AS n FROM deliverables
       WHERE client_id = ? AND posting_status='posted'
       GROUP BY platform ORDER BY n DESC LIMIT 3`,
      [clientId]
    );
    const postCountRow = await queryOne(
      `SELECT COUNT(*) AS n FROM deliverables
       WHERE client_id = ? AND posted_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
      [clientId]
    );

    const { result, provider } = await aiService.growthInsights({
      company: client.company_name,
      stats: latest || {},
      topPlatforms: platforms.map((p) => p.platform.replace(/_/g, ' ')),
      postCount: postCountRow.n,
    });
    ok(res, { ...result, provider });
  })
);

/* POST /api/analytics/sync — pull fresh data from Meta + YouTube (admin) */
router.post(
  '/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [meta, yt] = await Promise.all([metaService.syncAll(), youtubeService.syncAll()]);
    const live = meta.live || yt.live;
    ok(res, { meta, youtube: yt, live }, live
      ? `Synced — Instagram: ${meta.synced}, YouTube: ${yt.synced}`
      : 'No analytics APIs configured — using stored snapshots');
  })
);

/* GET /api/analytics/agency — aggregate across all clients (admin) */
router.get(
  '/agency',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.company_name,
        (SELECT followers FROM analytics_snapshots s WHERE s.client_id=c.id ORDER BY snapshot_date DESC LIMIT 1) AS followers,
        (SELECT engagement_rate FROM analytics_snapshots s WHERE s.client_id=c.id ORDER BY snapshot_date DESC LIMIT 1) AS engagement_rate,
        (SELECT COALESCE(SUM(reach),0) FROM analytics_snapshots s WHERE s.client_id=c.id
          AND s.snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS reach_30d
       FROM clients c WHERE c.status='active' ORDER BY c.company_name`
    );
    ok(res, rows);
  })
);

module.exports = router;
