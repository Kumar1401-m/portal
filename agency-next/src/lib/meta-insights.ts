/**
 * Parsing Meta Graph API insights payloads.
 *
 * Instagram has changed the shape of this response three times and serves
 * several of them at once depending on the API version, the metric and the
 * `metric_type` parameter:
 *
 *   { "data": [ { "name": "reach", "values": [ { "value": 1234 } ] } ] }      // classic
 *   { "data": [ { "name": "reach", "total_value": { "value": 1234 } } ] }     // metric_type=total_value
 *   { "data": [ { "name": "reach", "values": [ { "value": { "…": 1 } } ] } ]  // breakdowns
 *
 * Rather than pin the workflow to one version, everything is normalised here.
 * The alternative — teaching an n8n Code node to do it — puts the fragile part
 * in the place that is hardest to test and easiest to break by re-importing
 * the workflow.
 *
 * Metric names also drift (`impressions` and `plays` are deprecated in favour
 * of `views` on newer versions), so the aliases below map several spellings
 * onto one field. Unknown metrics are ignored, never fatal: Meta adding a
 * metric must not break the nightly job.
 */
import "server-only";

/** One entry of a Graph insights `data` array, in any of its shapes. */
type MetricEntry = {
  name?: string;
  period?: string;
  title?: string;
  values?: { value?: unknown; end_time?: string }[];
  total_value?: { value?: unknown };
};

type InsightsPayload = { data?: MetricEntry[] } | MetricEntry[] | null | undefined;

/**
 * Pull a single number out of an entry, whichever shape it arrived in.
 *
 * A breakdown response nests an object of segment → count where a plain number
 * would be; summing its values recovers the total the caller actually wanted.
 */
function valueOf(entry: MetricEntry): number {
  const direct = entry.total_value?.value;
  if (typeof direct === "number") return direct;

  const raw = entry.values?.[entry.values.length - 1]?.value;
  if (typeof raw === "number") return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).reduce<number>(
      (sum, v) => sum + (typeof v === "number" ? v : 0),
      0
    );
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Sum every daily value in an entry — used when a range was requested. */
function sumOf(entry: MetricEntry): number {
  if (!entry.values?.length) return valueOf(entry);
  return entry.values.reduce<number>((sum, v) => {
    const raw = v.value;
    if (typeof raw === "number") return sum + raw;
    if (raw && typeof raw === "object") {
      return (
        sum +
        Object.values(raw as Record<string, unknown>).reduce<number>(
          (s, x) => s + (typeof x === "number" ? x : 0),
          0
        )
      );
    }
    return sum;
  }, 0);
}

const entries = (payload: InsightsPayload): MetricEntry[] => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.data) ? payload.data : [];
};

/**
 * Metric aliases → our field names. Several Graph names map to one field
 * because Meta renamed them across versions and both still appear in the wild.
 */
const ACCOUNT_ALIASES: Record<string, keyof ParsedAccountInsights> = {
  reach: "reach",
  impressions: "impressions",
  views: "views",
  accounts_engaged: "accountsEngaged",
  profile_views: "profileVisits",
  profile_visits: "profileVisits",
  website_clicks: "websiteClicks",
  total_interactions: "totalInteractions",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saves: "saves",
  saved: "saves",
  follower_count: "followerDelta",
  follows_and_unfollows: "followerDelta",
};

export type ParsedAccountInsights = {
  reach: number;
  impressions: number;
  views: number;
  accountsEngaged: number;
  profileVisits: number;
  websiteClicks: number;
  totalInteractions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  followerDelta: number;
};

/**
 * Account-level metrics for one day.
 *
 * `sum` matters when the caller asked Graph for a date range rather than a
 * single day — each entry then carries several daily values and only the total
 * is meaningful.
 */
export function parseAccountInsights(
  payload: InsightsPayload,
  { sum = false }: { sum?: boolean } = {}
): ParsedAccountInsights {
  const out: ParsedAccountInsights = {
    reach: 0,
    impressions: 0,
    views: 0,
    accountsEngaged: 0,
    profileVisits: 0,
    websiteClicks: 0,
    totalInteractions: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    followerDelta: 0,
  };

  for (const entry of entries(payload)) {
    const field = ACCOUNT_ALIASES[(entry.name || "").toLowerCase()];
    if (!field) continue;
    out[field] += sum ? sumOf(entry) : valueOf(entry);
  }

  // Meta only serves total_interactions on some versions; derive it when it's
  // absent so the engagement rate isn't silently zero.
  if (!out.totalInteractions) {
    out.totalInteractions = out.likes + out.comments + out.shares + out.saves;
  }
  return out;
}

const MEDIA_ALIASES: Record<string, keyof ParsedMediaInsights> = {
  reach: "reach",
  impressions: "impressions",
  views: "views",
  video_views: "views",
  plays: "plays",
  ig_reels_video_view_total_time: "watchTimeMs",
  ig_reels_avg_watch_time: "avgWatchTimeMs",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saves",
  saves: "saves",
  total_interactions: "totalInteractions",
};

export type ParsedMediaInsights = {
  reach: number;
  impressions: number;
  views: number;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  totalInteractions: number;
  watchTimeMs: number;
  avgWatchTimeMs: number;
};

/** Lifetime metrics for one media object. */
export function parseMediaInsights(payload: InsightsPayload): ParsedMediaInsights {
  const out: ParsedMediaInsights = {
    reach: 0,
    impressions: 0,
    views: 0,
    plays: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    totalInteractions: 0,
    watchTimeMs: 0,
    avgWatchTimeMs: 0,
  };

  for (const entry of entries(payload)) {
    const field = MEDIA_ALIASES[(entry.name || "").toLowerCase()];
    if (!field) continue;
    out[field] += valueOf(entry);
  }

  // `plays` is deprecated in favour of `views` on newer versions; keep both
  // populated so a chart built on either one still has numbers.
  if (!out.plays && out.views) out.plays = out.views;
  if (!out.views && out.plays) out.views = out.plays;
  if (!out.totalInteractions) {
    out.totalInteractions = out.likes + out.comments + out.shares + out.saves;
  }
  return out;
}

/**
 * Merge the fields available on the media object itself (`like_count`,
 * `comments_count`) over the insights numbers.
 *
 * Those two are served by the media edge even when the insights edge refuses
 * the request — a brand new post, or a metric Meta won't serve for that media
 * type — so they're the more reliable source when both exist.
 */
export function mergeMediaCounts(
  insights: ParsedMediaInsights,
  media: { like_count?: unknown; comments_count?: unknown } | null | undefined
): ParsedMediaInsights {
  if (!media) return insights;
  const likeCount = typeof media.like_count === "number" ? media.like_count : null;
  const commentCount = typeof media.comments_count === "number" ? media.comments_count : null;

  const merged = {
    ...insights,
    likes: likeCount ?? insights.likes,
    comments: commentCount ?? insights.comments,
  };
  merged.totalInteractions = merged.likes + merged.comments + merged.shares + merged.saves;
  return merged;
}
