/**
 * YouTube Data API v3 integration (channel statistics).
 *
 * With YOUTUBE_API_KEY set and a client's youtube_channel_id configured, daily
 * channel stats (subscribers, views, videos) are fetched and stored as
 * analytics snapshots with platform='youtube'. Without a key, stored snapshots
 * (seeded/demo) are served so the dashboards still render.
 */
'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { query } = require('../config/db');

/** Fetch channel statistics for one client and upsert today's snapshot. */
async function syncClient(client) {
  if (!env.youtube.enabled || !client.youtube_channel_id) return null;
  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${client.youtube_channel_id}&key=${env.youtube.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`channels ${res.status}`);
    const data = await res.json();
    const stats = data.items && data.items[0] && data.items[0].statistics;
    if (!stats) return null;

    const subs = Number(stats.subscriberCount || 0);
    const views = Number(stats.viewCount || 0);

    await query(
      `INSERT INTO analytics_snapshots
        (client_id, platform, snapshot_date, followers, views, raw_json)
       VALUES (?,?,CURDATE(),?,?,?)
       ON DUPLICATE KEY UPDATE followers=VALUES(followers), views=VALUES(views), raw_json=VALUES(raw_json)`,
      [client.id, 'youtube', subs, views, JSON.stringify(stats)]
    );
    return true;
  } catch (err) {
    logger.warn(`YouTube sync failed for client ${client.id}:`, err.message);
    return null;
  }
}

/** Sync all active clients that have a YouTube channel id configured. */
async function syncAll() {
  if (!env.youtube.enabled) return { synced: 0, live: false };
  const clients = await query(
    "SELECT id, youtube_channel_id FROM clients WHERE status='active' AND youtube_channel_id IS NOT NULL"
  );
  let synced = 0;
  for (const c of clients) {
    if (await syncClient(c)) synced++;
  }
  return { synced, live: true };
}

module.exports = { syncClient, syncAll };
