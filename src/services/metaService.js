/**
 * Meta Graph API integration (Instagram/Facebook insights).
 *
 * With META_GRAPH_TOKEN set and a client's ig_user_id configured, live metrics
 * are fetched and stored as daily snapshots. Without a token, the app serves
 * the snapshot history already in the database (seeded demo data), so charts
 * and reports always render.
 */
'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { query, queryOne } = require('../config/db');

const GRAPH = `https://graph.facebook.com/${env.meta.version}`;

/** Fetch live IG insights for one client and upsert today's snapshot. */
async function syncClientInsights(client) {
  if (!env.meta.enabled || !client.ig_user_id) return null;
  try {
    const fields = 'followers_count,media_count';
    const profRes = await fetch(
      `${GRAPH}/${client.ig_user_id}?fields=${fields}&access_token=${env.meta.token}`
    );
    if (!profRes.ok) throw new Error(`profile ${profRes.status}`);
    const prof = await profRes.json();

    const metrics = 'reach,impressions,likes,comments,shares,saves';
    const insRes = await fetch(
      `${GRAPH}/${client.ig_user_id}/insights?metric=${metrics}&period=day&access_token=${env.meta.token}`
    );
    const ins = insRes.ok ? await insRes.json() : { data: [] };
    const get = (name) => {
      const m = (ins.data || []).find((x) => x.name === name);
      return m && m.values && m.values.length ? m.values[m.values.length - 1].value : 0;
    };

    const reach = get('reach');
    const likes = get('likes');
    const comments = get('comments');
    const shares = get('shares');
    const saves = get('saves');
    const engagement = reach ? (((likes + comments + shares + saves) / reach) * 100).toFixed(2) : 0;

    await query(
      `INSERT INTO analytics_snapshots
        (client_id, platform, snapshot_date, followers, reach, impressions, likes, comments, shares, saves, engagement_rate, raw_json)
       VALUES (?,?,CURDATE(),?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE followers=VALUES(followers), reach=VALUES(reach),
         impressions=VALUES(impressions), likes=VALUES(likes), comments=VALUES(comments),
         shares=VALUES(shares), saves=VALUES(saves), engagement_rate=VALUES(engagement_rate),
         raw_json=VALUES(raw_json)`,
      [
        client.id, 'instagram', prof.followers_count || 0, reach, get('impressions'),
        likes, comments, shares, saves, engagement, JSON.stringify({ prof, ins }),
      ]
    );
    return true;
  } catch (err) {
    logger.warn(`Meta sync failed for client ${client.id}:`, err.message);
    return null;
  }
}

/** Sync all active clients that have an IG id configured. */
async function syncAll() {
  if (!env.meta.enabled) return { synced: 0, live: false };
  const clients = await query(
    "SELECT id, ig_user_id FROM clients WHERE status='active' AND ig_user_id IS NOT NULL"
  );
  let synced = 0;
  for (const c of clients) {
    if (await syncClientInsights(c)) synced++;
  }
  return { synced, live: true };
}

/** Analytics summary for a client over a date range, from stored snapshots. */
async function getClientAnalytics(clientId, days = 30, platform = 'instagram') {
  const rows = await query(
    `SELECT snapshot_date, followers, reach, impressions, views, likes, comments, shares, saves, engagement_rate
     FROM analytics_snapshots
     WHERE client_id = ? AND platform = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY snapshot_date ASC`,
    [clientId, platform, days]
  );
  const latest = rows[rows.length - 1] || null;
  const first = rows[0] || null;
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const summary = latest
    ? {
        followers: Number(latest.followers),
        follower_growth: first ? Number(latest.followers) - Number(first.followers) : 0,
        reach: sum('reach'),
        impressions: sum('impressions'),
        views: sum('views'),
        likes: sum('likes'),
        comments: sum('comments'),
        shares: sum('shares'),
        saves: sum('saves'),
        engagement_rate: latest.engagement_rate,
      }
    : null;
  return { series: rows, summary, live: env.meta.enabled };
}

/** Best performing content = completed deliverables ranked by AI score. */
async function getBestContent(clientId, limit = 5) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
  return query(
    `SELECT id, title, platform, posted_at, ai_score
     FROM deliverables
     WHERE client_id = ? AND posting_status = 'posted'
     ORDER BY ai_score DESC, posted_at DESC
     LIMIT ${cappedLimit}`,
    [clientId]
  );
}

module.exports = { syncClientInsights, syncAll, getClientAnalytics, getBestContent };
