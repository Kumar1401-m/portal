/**
 * Instagram analytics — storage for the daily insights job, and the queries
 * behind the analytics dashboard.
 *
 * Two grains, on purpose:
 *
 *   `analytics_snapshots` — one row per client per DAY. Meta's account-level
 *     metrics (reach, profile visits, follows…) are already day-scoped, so
 *     these values are additive across a date range.
 *
 *   `post_insights` — one row per media per DAY, holding Instagram's LIFETIME
 *     totals for that post as of that day. These are NOT additive across days:
 *     summing a post's rows would count the same likes once per day it was
 *     collected. Anything post-level therefore reads the most recent row per
 *     media and filters on when the post was *published*, which is also how an
 *     agency reads it — "the posts we put out in July have earned X".
 *
 * Getting that distinction wrong is the easiest way to produce a chart that
 * looks plausible and is wrong by a factor of thirty, so every query below
 * says which grain it works in.
 */
import "server-only";
import { query, queryOne, execute, hasColumn } from "./db";

const n = (v: unknown) => Number(v ?? 0);

/* ============================ Writing (the n8n job) ============================ */

export type AccountSnapshotInput = {
  clientId: number;
  platform?: string;
  /** YYYY-MM-DD. The day the metrics describe, not the day we fetched them. */
  date: string;
  followers?: number;
  followerDelta?: number;
  reach?: number;
  impressions?: number;
  views?: number;
  accountsEngaged?: number;
  profileVisits?: number;
  websiteClicks?: number;
  reelPlays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  totalInteractions?: number;
  postsCount?: number;
  raw?: unknown;
};

/**
 * Upsert one day of account metrics.
 *
 * Idempotent by (client, platform, date) so the daily job can be re-run — for
 * a backfill, or because yesterday's run failed — without duplicating a day.
 *
 * `followers` is a running total, so it's only written when the caller
 * actually has a number: a failed follower fetch must not overwrite a real
 * count with a zero and put a cliff in the followers chart.
 */
export async function saveAccountSnapshot(input: AccountSnapshotInput): Promise<void> {
  const interactions =
    input.totalInteractions ??
    n(input.likes) + n(input.comments) + n(input.shares) + n(input.saves);
  const reach = n(input.reach);
  const engagementRate = reach > 0 ? Math.round((interactions / reach) * 10000) / 100 : 0;

  await execute(
    `INSERT INTO analytics_snapshots
       (client_id, platform, snapshot_date, followers, follower_delta, reach, impressions,
        views, accounts_engaged, profile_visits, website_clicks, reel_plays,
        likes, comments, shares, saves, total_interactions, posts_count,
        engagement_rate, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       followers          = IF(VALUES(followers) > 0, VALUES(followers), followers),
       follower_delta     = VALUES(follower_delta),
       reach              = VALUES(reach),
       impressions        = VALUES(impressions),
       views              = VALUES(views),
       accounts_engaged   = VALUES(accounts_engaged),
       profile_visits     = VALUES(profile_visits),
       website_clicks     = VALUES(website_clicks),
       reel_plays         = VALUES(reel_plays),
       likes              = VALUES(likes),
       comments           = VALUES(comments),
       shares             = VALUES(shares),
       saves              = VALUES(saves),
       total_interactions = VALUES(total_interactions),
       posts_count        = VALUES(posts_count),
       engagement_rate    = VALUES(engagement_rate),
       raw_json           = VALUES(raw_json)`,
    [
      input.clientId,
      input.platform || "instagram",
      input.date,
      n(input.followers),
      n(input.followerDelta),
      reach,
      n(input.impressions),
      n(input.views),
      n(input.accountsEngaged),
      n(input.profileVisits),
      n(input.websiteClicks),
      n(input.reelPlays),
      n(input.likes),
      n(input.comments),
      n(input.shares),
      n(input.saves),
      interactions,
      n(input.postsCount),
      engagementRate,
      input.raw ? JSON.stringify(input.raw) : null,
    ]
  );
}

export type PostInsightInput = {
  clientId: number;
  mediaId: string;
  platform?: string;
  date: string;
  deliverableId?: number | null;
  mediaType?: string | null;
  permalink?: string | null;
  thumbnailUrl?: string | null;
  caption?: string | null;
  publishedAt?: string | null;
  reach?: number;
  impressions?: number;
  views?: number;
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  totalInteractions?: number;
  raw?: unknown;
};

/**
 * Upsert one media's lifetime metrics as of one day.
 *
 * `deliverable_id` is resolved here rather than trusted from the caller: the
 * link between a portal task and a live Instagram post is `instagram_media_id`,
 * and matching on it means posts published outside the portal still get
 * recorded (with a NULL deliverable) instead of being dropped.
 */
export async function savePostInsight(input: PostInsightInput): Promise<void> {
  const interactions =
    input.totalInteractions ??
    n(input.likes) + n(input.comments) + n(input.shares) + n(input.saves);
  // Reach is the honest denominator for a single post; fall back to
  // impressions, then views, so a post still gets a rate when Meta omits reach.
  const denom = n(input.reach) || n(input.impressions) || n(input.views);
  const engagementRate = denom > 0 ? Math.round((interactions / denom) * 10000) / 100 : 0;

  let deliverableId = input.deliverableId ?? null;
  if (deliverableId == null) {
    const d = await queryOne<{ id: number }>(
      "SELECT id FROM deliverables WHERE instagram_media_id = ? LIMIT 1",
      [input.mediaId]
    );
    deliverableId = d ? d.id : null;
  }

  await execute(
    `INSERT INTO post_insights
       (deliverable_id, client_id, platform, media_id, media_type, permalink, thumbnail_url,
        caption, published_at, snapshot_date, reach, impressions, views, plays,
        likes, comments, shares, saves, total_interactions, engagement_rate, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       deliverable_id     = COALESCE(VALUES(deliverable_id), deliverable_id),
       media_type         = COALESCE(VALUES(media_type), media_type),
       permalink          = COALESCE(VALUES(permalink), permalink),
       thumbnail_url      = COALESCE(VALUES(thumbnail_url), thumbnail_url),
       caption            = COALESCE(VALUES(caption), caption),
       published_at       = COALESCE(VALUES(published_at), published_at),
       reach              = VALUES(reach),
       impressions        = VALUES(impressions),
       views              = VALUES(views),
       plays              = VALUES(plays),
       likes              = VALUES(likes),
       comments           = VALUES(comments),
       shares             = VALUES(shares),
       saves              = VALUES(saves),
       total_interactions = VALUES(total_interactions),
       engagement_rate    = VALUES(engagement_rate),
       raw_json           = VALUES(raw_json)`,
    [
      deliverableId,
      input.clientId,
      input.platform || "instagram",
      input.mediaId,
      input.mediaType ?? null,
      input.permalink ?? null,
      input.thumbnailUrl ?? null,
      input.caption ? String(input.caption).slice(0, 2200) : null,
      input.publishedAt ?? null,
      input.date,
      n(input.reach),
      n(input.impressions),
      n(input.views),
      n(input.plays),
      n(input.likes),
      n(input.comments),
      n(input.shares),
      n(input.saves),
      interactions,
      engagementRate,
      input.raw ? JSON.stringify(input.raw) : null,
    ]
  );

  // Mirror the headline numbers onto the deliverable so the task list can show
  // performance without joining the history table on every render.
  if (deliverableId) {
    await execute(
      `UPDATE deliverables
          SET metric_views = ?, metric_reach = ?, metric_likes = ?,
              metric_comments = ?, metric_shares = ?, metric_saves = ?
        WHERE id = ?`,
      [
        n(input.views) || n(input.plays),
        n(input.reach),
        n(input.likes),
        n(input.comments),
        n(input.shares),
        n(input.saves),
        deliverableId,
      ]
    );
  }
}

/* ============================== Reading (dashboard) ============================== */

export type AnalyticsFilters = {
  clientId?: number | null;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  platform?: string;
  campaign?: string | null;
  /** crm/client role scoping: null = unrestricted, [] = nothing visible. */
  allowedClientIds?: number[] | null;
};

/** Has the analytics schema been applied yet? */
export async function analyticsReady(): Promise<boolean> {
  return hasColumn("analytics_snapshots", "profile_visits");
}

/** Shared client scoping for both grains. `alias` is the table's alias. */
function scopeSql(
  f: AnalyticsFilters,
  alias: string
): { sql: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];

  conds.push(`${alias}.platform = ?`);
  params.push(f.platform || "instagram");

  if (f.clientId) {
    conds.push(`${alias}.client_id = ?`);
    params.push(f.clientId);
  }
  if (f.allowedClientIds !== undefined && f.allowedClientIds !== null) {
    if (f.allowedClientIds.length === 0) {
      conds.push("1=0");
    } else {
      conds.push(`${alias}.client_id IN (${f.allowedClientIds.map(() => "?").join(",")})`);
      params.push(...f.allowedClientIds);
    }
  }
  return { sql: conds.join(" AND "), params };
}

export type MetricTotals = {
  reach: number;
  impressions: number;
  views: number;
  accountsEngaged: number;
  profileVisits: number;
  websiteClicks: number;
  reelPlays: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  totalInteractions: number;
  followerGrowth: number;
  /** Latest known follower count in the window (a running total, not a sum). */
  followers: number;
  postsCount: number;
  engagementRate: number;
};

const EMPTY_TOTALS: MetricTotals = {
  reach: 0,
  impressions: 0,
  views: 0,
  accountsEngaged: 0,
  profileVisits: 0,
  websiteClicks: 0,
  reelPlays: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  totalInteractions: 0,
  followerGrowth: 0,
  followers: 0,
  postsCount: 0,
  engagementRate: 0,
};

/**
 * Account-grain totals for a window.
 *
 * Day-scoped metrics are summed. `followers` is deliberately not: it's a
 * running total, so the meaningful figure is the most recent non-zero reading,
 * with `followerGrowth` carrying the change.
 */
export async function getTotals(f: AnalyticsFilters): Promise<MetricTotals> {
  if (!(await analyticsReady())) return EMPTY_TOTALS;
  const { sql, params } = scopeSql(f, "a");

  const row = await queryOne<Record<string, unknown>>(
    `SELECT COALESCE(SUM(a.reach),0)              AS reach,
            COALESCE(SUM(a.impressions),0)        AS impressions,
            COALESCE(SUM(a.views),0)              AS views,
            COALESCE(SUM(a.accounts_engaged),0)   AS accounts_engaged,
            COALESCE(SUM(a.profile_visits),0)     AS profile_visits,
            COALESCE(SUM(a.website_clicks),0)     AS website_clicks,
            COALESCE(SUM(a.reel_plays),0)         AS reel_plays,
            COALESCE(SUM(a.likes),0)              AS likes,
            COALESCE(SUM(a.comments),0)           AS comments,
            COALESCE(SUM(a.shares),0)             AS shares,
            COALESCE(SUM(a.saves),0)              AS saves,
            COALESCE(SUM(a.total_interactions),0) AS total_interactions,
            COALESCE(SUM(a.follower_delta),0)     AS follower_growth,
            COALESCE(SUM(a.posts_count),0)        AS posts_count
       FROM analytics_snapshots a
      WHERE ${sql} AND a.snapshot_date BETWEEN ? AND ?`,
    [...params, f.from, f.to]
  );

  // Latest non-zero reading in the window — a zero means "not collected", not
  // "the account lost all its followers".
  const fr = await queryOne<{ followers: number }>(
    `SELECT a.followers FROM analytics_snapshots a
      WHERE ${sql} AND a.snapshot_date BETWEEN ? AND ? AND a.followers > 0
      ORDER BY a.snapshot_date DESC LIMIT 1`,
    [...params, f.from, f.to]
  );

  const reach = n(row?.reach);
  const interactions = n(row?.total_interactions);
  return {
    reach,
    impressions: n(row?.impressions),
    views: n(row?.views),
    accountsEngaged: n(row?.accounts_engaged),
    profileVisits: n(row?.profile_visits),
    websiteClicks: n(row?.website_clicks),
    reelPlays: n(row?.reel_plays),
    likes: n(row?.likes),
    comments: n(row?.comments),
    shares: n(row?.shares),
    saves: n(row?.saves),
    totalInteractions: interactions,
    followerGrowth: n(row?.follower_growth),
    followers: n(fr?.followers),
    postsCount: n(row?.posts_count),
    engagementRate: reach > 0 ? Math.round((interactions / reach) * 10000) / 100 : 0,
  };
}

/** The window of the same length immediately before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(prevStart), to: iso(prevEnd) };
}

/**
 * Percentage change, as a signed number.
 *
 * Returns null rather than Infinity when the baseline is zero: "up ∞%" from
 * nothing is not a fact anyone can act on, and the UI shows "new" instead.
 */
export function growthPercent(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type ComparedTotals = {
  current: MetricTotals;
  previous: MetricTotals;
  growth: Record<keyof MetricTotals, number | null>;
  previousRange: { from: string; to: string };
};

/** Totals for the window, the window before it, and the change between them. */
export async function getComparedTotals(f: AnalyticsFilters): Promise<ComparedTotals> {
  const prev = previousPeriod(f.from, f.to);
  const [current, previous] = await Promise.all([
    getTotals(f),
    getTotals({ ...f, from: prev.from, to: prev.to }),
  ]);

  const growth = {} as Record<keyof MetricTotals, number | null>;
  for (const key of Object.keys(EMPTY_TOTALS) as (keyof MetricTotals)[]) {
    growth[key] = growthPercent(current[key], previous[key]);
  }
  return { current, previous, growth, previousRange: prev };
}

export type SeriesPoint = {
  /** Bucket label: YYYY-MM-DD for daily, ISO week for weekly, YYYY-MM monthly. */
  bucket: string;
  reach: number;
  views: number;
  impressions: number;
  interactions: number;
  followers: number;
  followerDelta: number;
  profileVisits: number;
  engagementRate: number;
};

export type Grain = "day" | "week" | "month";

/**
 * Account-grain time series, bucketed by day, ISO week or month.
 *
 * Followers is aggregated with MAX rather than SUM — it's a running total, so
 * summing seven days of it would report seven times the audience.
 */
export async function getSeries(f: AnalyticsFilters, grain: Grain = "day"): Promise<SeriesPoint[]> {
  if (!(await analyticsReady())) return [];
  const { sql, params } = scopeSql(f, "a");

  const bucket =
    grain === "month"
      ? "DATE_FORMAT(a.snapshot_date, '%Y-%m')"
      : grain === "week"
        ? // ISO week (mode 3): weeks start Monday, which is how the agency and
          // Instagram both count them.
          "CONCAT(YEAR(a.snapshot_date), '-W', LPAD(WEEK(a.snapshot_date, 3), 2, '0'))"
        : "DATE_FORMAT(a.snapshot_date, '%Y-%m-%d')";

  const rows = await query<Record<string, unknown>>(
    `SELECT ${bucket} AS bucket,
            COALESCE(SUM(a.reach),0)              AS reach,
            COALESCE(SUM(a.views),0)              AS views,
            COALESCE(SUM(a.impressions),0)        AS impressions,
            COALESCE(SUM(a.total_interactions),0) AS interactions,
            COALESCE(MAX(a.followers),0)          AS followers,
            COALESCE(SUM(a.follower_delta),0)     AS follower_delta,
            COALESCE(SUM(a.profile_visits),0)     AS profile_visits
       FROM analytics_snapshots a
      WHERE ${sql} AND a.snapshot_date BETWEEN ? AND ?
      GROUP BY bucket
      ORDER BY MIN(a.snapshot_date)`,
    [...params, f.from, f.to]
  );

  return rows.map((r) => {
    const reach = n(r.reach);
    const interactions = n(r.interactions);
    return {
      bucket: String(r.bucket),
      reach,
      views: n(r.views),
      impressions: n(r.impressions),
      interactions,
      followers: n(r.followers),
      followerDelta: n(r.follower_delta),
      profileVisits: n(r.profile_visits),
      engagementRate: reach > 0 ? Math.round((interactions / reach) * 10000) / 100 : 0,
    };
  });
}

/**
 * Post-grain scoping. Filters on when the post was PUBLISHED (not when it was
 * measured), and restricts to each media's most recent snapshot so lifetime
 * totals aren't counted once per collection day.
 */
function postScope(f: AnalyticsFilters): { join: string; where: string; params: (string | number)[] } {
  const { sql, params } = scopeSql(f, "p");
  const conds = [sql, "p.published_at >= ?", "p.published_at < DATE_ADD(?, INTERVAL 1 DAY)"];
  const all: (string | number)[] = [...params, f.from, f.to];

  // Campaign lives on the deliverable, so filtering by it necessarily drops
  // media published outside the portal — there is nothing to attribute them to.
  let join = "LEFT JOIN deliverables d ON d.id = p.deliverable_id";
  if (f.campaign) {
    join = "JOIN deliverables d ON d.id = p.deliverable_id";
    conds.push("d.campaign = ?");
    all.push(f.campaign);
  }

  return { join, where: conds.join(" AND "), params: all };
}

/**
 * The `latest row per media` subquery both post-grain queries build on.
 * Written as a join against MAX(snapshot_date) rather than a window function
 * so it runs on MySQL 5.7 as well as 8.
 */
const LATEST_PER_MEDIA = `
  JOIN (SELECT media_id, MAX(snapshot_date) AS latest_date
          FROM post_insights GROUP BY media_id) lm
    ON lm.media_id = p.media_id AND lm.latest_date = p.snapshot_date`;

export type TopPost = {
  mediaId: string;
  deliverableId: number | null;
  title: string | null;
  clientName: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  mediaType: string | null;
  publishedAt: string | null;
  reach: number;
  views: number;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  totalInteractions: number;
  engagementRate: number;
};

/**
 * Best-performing posts published in the window.
 *
 * Ranked by engagement rate, not raw likes: a post that reached 500 people and
 * moved 100 of them taught the agency more than one that reached 50,000 and
 * moved 200. `reach >= 100` keeps a post seen by nine people with one like
 * from topping the chart at 11%.
 */
export async function getTopPosts(f: AnalyticsFilters, limit = 10): Promise<TopPost[]> {
  if (!(await analyticsReady())) return [];
  const { join, where, params } = postScope(f);

  const rows = await query<Record<string, unknown>>(
    `SELECT p.media_id, p.deliverable_id, d.title, c.company_name, p.permalink,
            p.thumbnail_url, p.caption, p.media_type, p.published_at,
            p.reach, p.views, p.plays, p.likes, p.comments, p.shares, p.saves,
            p.total_interactions, p.engagement_rate
       FROM post_insights p
       ${LATEST_PER_MEDIA}
       ${join}
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE ${where}
      ORDER BY (p.reach >= 100) DESC, p.engagement_rate DESC, p.total_interactions DESC
      LIMIT ${Number(limit) || 10}`,
    params
  );

  return rows.map((r) => ({
    mediaId: String(r.media_id),
    deliverableId: r.deliverable_id == null ? null : n(r.deliverable_id),
    title: (r.title as string) ?? null,
    clientName: (r.company_name as string) ?? null,
    permalink: (r.permalink as string) ?? null,
    thumbnailUrl: (r.thumbnail_url as string) ?? null,
    caption: (r.caption as string) ?? null,
    mediaType: (r.media_type as string) ?? null,
    publishedAt: (r.published_at as string) ?? null,
    reach: n(r.reach),
    views: n(r.views),
    plays: n(r.plays),
    likes: n(r.likes),
    comments: n(r.comments),
    shares: n(r.shares),
    saves: n(r.saves),
    totalInteractions: n(r.total_interactions),
    engagementRate: n(r.engagement_rate),
  }));
}

export type EngagementBreakdown = {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
};

/** Post-grain interaction mix for posts published in the window. */
export async function getEngagementBreakdown(f: AnalyticsFilters): Promise<EngagementBreakdown> {
  if (!(await analyticsReady())) return { likes: 0, comments: 0, shares: 0, saves: 0 };
  const { join, where, params } = postScope(f);

  const row = await queryOne<Record<string, unknown>>(
    `SELECT COALESCE(SUM(p.likes),0) AS likes, COALESCE(SUM(p.comments),0) AS comments,
            COALESCE(SUM(p.shares),0) AS shares, COALESCE(SUM(p.saves),0) AS saves
       FROM post_insights p ${LATEST_PER_MEDIA} ${join}
      WHERE ${where}`,
    params
  );
  return {
    likes: n(row?.likes),
    comments: n(row?.comments),
    shares: n(row?.shares),
    saves: n(row?.saves),
  };
}

export type FrequencyPoint = { bucket: string; posts: number; reach: number };

/**
 * How many posts went out per bucket, and what they reached. Post-grain and
 * keyed on publish date, so it answers "did posting more actually help?".
 */
export async function getPostingFrequency(
  f: AnalyticsFilters,
  grain: Grain = "week"
): Promise<FrequencyPoint[]> {
  if (!(await analyticsReady())) return [];
  const { join, where, params } = postScope(f);

  const bucket =
    grain === "month"
      ? "DATE_FORMAT(p.published_at, '%Y-%m')"
      : grain === "week"
        ? "CONCAT(YEAR(p.published_at), '-W', LPAD(WEEK(p.published_at, 3), 2, '0'))"
        : "DATE_FORMAT(p.published_at, '%Y-%m-%d')";

  const rows = await query<Record<string, unknown>>(
    `SELECT ${bucket} AS bucket, COUNT(*) AS posts, COALESCE(SUM(p.reach),0) AS reach
       FROM post_insights p ${LATEST_PER_MEDIA} ${join}
      WHERE ${where}
      GROUP BY bucket
      ORDER BY MIN(p.published_at)`,
    params
  );
  return rows.map((r) => ({ bucket: String(r.bucket), posts: n(r.posts), reach: n(r.reach) }));
}

export type TimingCell = {
  /** 1 = Sunday … 7 = Saturday, matching MySQL's DAYOFWEEK. */
  dayOfWeek: number;
  hour: number;
  posts: number;
  avgEngagementRate: number;
  avgReach: number;
};

/**
 * Average performance by weekday and hour of publication — the evidence behind
 * the "best posting time" recommendation, and a heatmap in its own right.
 */
export async function getTimingPerformance(f: AnalyticsFilters): Promise<TimingCell[]> {
  if (!(await analyticsReady())) return [];
  const { join, where, params } = postScope(f);

  const rows = await query<Record<string, unknown>>(
    `SELECT DAYOFWEEK(p.published_at) AS dow, HOUR(p.published_at) AS hr,
            COUNT(*) AS posts,
            ROUND(AVG(p.engagement_rate), 2) AS avg_er,
            ROUND(AVG(p.reach)) AS avg_reach
       FROM post_insights p ${LATEST_PER_MEDIA} ${join}
      WHERE ${where} AND p.published_at IS NOT NULL
      GROUP BY dow, hr
      ORDER BY dow, hr`,
    params
  );
  return rows.map((r) => ({
    dayOfWeek: n(r.dow),
    hour: n(r.hr),
    posts: n(r.posts),
    avgEngagementRate: n(r.avg_er),
    avgReach: n(r.avg_reach),
  }));
}

export type ContentTypePerformance = {
  label: string;
  posts: number;
  avgEngagementRate: number;
  avgReach: number;
  totalInteractions: number;
};

/**
 * Performance by content category (the portal's own taxonomy where a post came
 * from a task, otherwise Instagram's media type). Feeds the "what should we
 * make more of" recommendation.
 */
export async function getContentTypePerformance(
  f: AnalyticsFilters
): Promise<ContentTypePerformance[]> {
  if (!(await analyticsReady())) return [];
  const { where, params } = postScope(f);
  // Always LEFT JOIN here: a post with no task still has a media type worth
  // reporting, and grouping is on the coalesced label anyway.
  const join = f.campaign
    ? "JOIN deliverables d ON d.id = p.deliverable_id"
    : "LEFT JOIN deliverables d ON d.id = p.deliverable_id";

  const rows = await query<Record<string, unknown>>(
    `SELECT COALESCE(NULLIF(d.content_category,''), p.media_type, 'Unknown') AS label,
            COUNT(*) AS posts,
            ROUND(AVG(p.engagement_rate), 2) AS avg_er,
            ROUND(AVG(p.reach)) AS avg_reach,
            COALESCE(SUM(p.total_interactions),0) AS interactions
       FROM post_insights p ${LATEST_PER_MEDIA} ${join}
      WHERE ${where}
      GROUP BY label
      ORDER BY avg_er DESC`,
    params
  );
  return rows.map((r) => ({
    label: String(r.label),
    posts: n(r.posts),
    avgEngagementRate: n(r.avg_er),
    avgReach: n(r.avg_reach),
    totalInteractions: n(r.interactions),
  }));
}

export type ClientPerformanceRow = {
  clientId: number;
  clientName: string;
  igUsername: string | null;
  followers: number;
  followerGrowth: number;
  reach: number;
  views: number;
  interactions: number;
  engagementRate: number;
  posts: number;
};

/** One row per client — the client-wise comparison table. */
export async function getClientPerformance(f: AnalyticsFilters): Promise<ClientPerformanceRow[]> {
  if (!(await analyticsReady())) return [];
  const { sql, params } = scopeSql(f, "a");

  const rows = await query<Record<string, unknown>>(
    `SELECT a.client_id, c.company_name, c.ig_username,
            COALESCE(MAX(a.followers),0)          AS followers,
            COALESCE(SUM(a.follower_delta),0)     AS follower_growth,
            COALESCE(SUM(a.reach),0)              AS reach,
            COALESCE(SUM(a.views),0)              AS views,
            COALESCE(SUM(a.total_interactions),0) AS interactions,
            COALESCE(SUM(a.posts_count),0)        AS posts
       FROM analytics_snapshots a
       JOIN clients c ON c.id = a.client_id
      WHERE ${sql} AND a.snapshot_date BETWEEN ? AND ? AND c.status <> 'churned'
      GROUP BY a.client_id, c.company_name, c.ig_username
      ORDER BY reach DESC`,
    [...params, f.from, f.to]
  );

  return rows.map((r) => {
    const reach = n(r.reach);
    const interactions = n(r.interactions);
    return {
      clientId: n(r.client_id),
      clientName: String(r.company_name),
      igUsername: (r.ig_username as string) ?? null,
      followers: n(r.followers),
      followerGrowth: n(r.follower_growth),
      reach,
      views: n(r.views),
      interactions,
      engagementRate: reach > 0 ? Math.round((interactions / reach) * 10000) / 100 : 0,
      posts: n(r.posts),
    };
  });
}

/** Campaign names that actually have posts behind them, for the filter. */
export async function getCampaigns(allowedClientIds?: number[] | null): Promise<string[]> {
  if (allowedClientIds && allowedClientIds.length === 0) return [];
  const scope =
    allowedClientIds && allowedClientIds.length
      ? `AND client_id IN (${allowedClientIds.map(() => "?").join(",")})`
      : "";
  const rows = await query<{ campaign: string }>(
    `SELECT DISTINCT campaign FROM deliverables
      WHERE campaign IS NOT NULL AND campaign <> '' ${scope}
      ORDER BY campaign`,
    allowedClientIds && allowedClientIds.length ? allowedClientIds : []
  );
  return rows.map((r) => r.campaign);
}

export type AnalyticsClient = {
  id: number;
  company_name: string;
  ig_username: string | null;
  analytics_enabled: number;
};

/** Clients with an Instagram account connected — the client filter's options. */
export async function getAnalyticsClients(
  allowedClientIds?: number[] | null
): Promise<AnalyticsClient[]> {
  if (allowedClientIds && allowedClientIds.length === 0) return [];
  if (!(await hasColumn("clients", "ig_username"))) {
    return query<AnalyticsClient>(
      `SELECT id, company_name, NULL AS ig_username, 1 AS analytics_enabled
         FROM clients WHERE status <> 'churned' ORDER BY company_name`
    );
  }
  const scope =
    allowedClientIds && allowedClientIds.length
      ? `AND id IN (${allowedClientIds.map(() => "?").join(",")})`
      : "";
  return query<AnalyticsClient>(
    `SELECT id, company_name, ig_username, analytics_enabled
       FROM clients
      WHERE status <> 'churned' AND ig_user_id IS NOT NULL AND ig_user_id <> '' ${scope}
      ORDER BY company_name`,
    allowedClientIds && allowedClientIds.length ? allowedClientIds : []
  );
}

/** When the daily job last wrote anything — shown as "data through <date>". */
export async function getLastSyncDate(clientId?: number | null): Promise<string | null> {
  if (!(await analyticsReady())) return null;
  const row = await queryOne<{ d: string | null }>(
    `SELECT MAX(snapshot_date) AS d FROM analytics_snapshots
      ${clientId ? "WHERE client_id = ?" : ""}`,
    clientId ? [clientId] : []
  );
  return row?.d ?? null;
}
