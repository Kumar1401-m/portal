/**
 * How many people follow this client, on each platform.
 *
 * Ad numbers say what a campaign cost and what it returned. They say nothing
 * about whether the account it ran on is growing, which is the other half of
 * the question a client asks — and the half nobody could answer from the
 * portal without opening two apps.
 *
 * Read live rather than stored. A follower count is a number Meta already
 * holds and revises; keeping our own copy would mean a sync job, a staleness
 * question on every screen, and a second version of a fact that has exactly
 * one true value. When growth over time is wanted, that is a daily snapshot
 * table and a deliberate decision — not a side effect of showing a number.
 *
 * Never throws. This sits beside spend and impressions on a page whose real
 * job is the ad account, and a Graph call that fails must not take that page
 * down with it: every failure returns null and the caller renders nothing.
 */
import "server-only";
import { query, queryOne, execute, hasTable, hasColumn } from "./db";
import { env } from "./env";

const GRAPH = "https://graph.facebook.com";

/** A month's closing follower count. */
/** The three accounts a client can have work published to. */
export type PlatformKey = "instagram" | "facebook" | "youtube";

export type MonthPoint = { month: string; followers: number };

export type Platform = {
  followers: number;
  /** Oldest first, at most twelve. Empty until a second month is recorded. */
  history: MonthPoint[];
  /** Gained since the end of last month. Null when there is no last month. */
  change: number | null;
};

export type Audience = {
  instagram: (Platform & { username: string | null }) | null;
  facebook: (Platform & { name: string | null }) | null;
  youtube: (Platform & { channelId: string | null }) | null;
};

type Row = {
  ig_user_id: string | null;
  ig_username: string | null;
  fb_page_id: string | null;
  ig_access_token: string | null;
  youtube_channel_id: string | null;
};

/**
 * Both counts, in as few calls as the client's setup allows.
 *
 * A Page and the Instagram account linked to it can be read together —
 * `/{page-id}?fields=followers_count,instagram_business_account{followers_count}`
 * is one request for both numbers — so a client with a Page configured costs
 * one call rather than two. A client with only Instagram falls back to asking
 * the Instagram node directly.
 *
 * `followers_count` on a Page superseded `fan_count` (page likes), which is a
 * different and now-smaller number that Meta stopped surfacing in its own UI.
 * Both are requested and followers wins, so a Page on an older API version
 * still shows something rather than a dash.
 */
export async function getAudience(clientId: number): Promise<Audience | null> {
  const c = await queryOne<Row>(
    `SELECT ig_user_id, ig_username, fb_page_id, ig_access_token,
            ${(await hasColumn("clients", "youtube_channel_id")) ? "youtube_channel_id" : "NULL AS youtube_channel_id"}
       FROM clients WHERE id = ?`,
    [clientId]
  );
  if (!c) return null;

  const token = c.ig_access_token || env.meta.accessToken;
  const wantsYouTube = Boolean(env.youtube.enabled && c.youtube_channel_id);
  if ((!token || (!c.ig_user_id && !c.fb_page_id)) && !wantsYouTube) return null;

  const v = env.meta.apiVersion;
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(
        `${GRAPH}/${v}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
        // Short, and on a page somebody is waiting for. A follower count is
        // worth having but never worth holding the ad figures back for.
        { cache: "no-store", signal: AbortSignal.timeout(6_000) }
      );
      const j = (await res.json().catch(() => ({}))) as T & { error?: unknown };
      return j.error ? null : j;
    } catch {
      return null;
    }
  };

  let ig: { username: string | null; followers: number } | null = null;
  let fb: { name: string | null; followers: number } | null = null;

  if (c.fb_page_id) {
    const page = await get<{
      name?: string;
      followers_count?: number;
      fan_count?: number;
      instagram_business_account?: { username?: string; followers_count?: number };
    }>(
      `/${c.fb_page_id}?fields=name,followers_count,fan_count,` +
        `instagram_business_account{username,followers_count}`
    );
    if (page) {
      const followers = page.followers_count ?? page.fan_count;
      if (typeof followers === "number") {
        fb = { name: page.name ?? null, followers };
      }
      const linked = page.instagram_business_account;
      if (linked && typeof linked.followers_count === "number") {
        ig = { username: linked.username ?? c.ig_username, followers: linked.followers_count };
      }
    }
  }

  // Either there is no Page, or the Page did not carry the linked account —
  // a client can have Instagram set up here without their Page id being
  // filled in, and that must still produce a number.
  if (!ig && c.ig_user_id) {
    const direct = await get<{ username?: string; followers_count?: number }>(
      `/${c.ig_user_id}?fields=username,followers_count`
    );
    if (direct && typeof direct.followers_count === "number") {
      ig = { username: direct.username ?? c.ig_username, followers: direct.followers_count };
    }
  }

  /*
   * YouTube, on its own API and its own key.
   *
   * Nothing here is shared with the Meta calls above: a different host, a
   * different credential, and a channel that may be connected on a client
   * whose Instagram is not. So it is asked for independently and its absence
   * costs the other two nothing.
   */
  let yt: { channelId: string | null; followers: number } | null = null;
  if (wantsYouTube) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=statistics` +
          `&id=${encodeURIComponent(c.youtube_channel_id!)}` +
          `&key=${encodeURIComponent(env.youtube.apiKey)}`,
        { cache: "no-store", signal: AbortSignal.timeout(6_000) }
      );
      const j = (await res.json().catch(() => ({}))) as {
        items?: { statistics?: { subscriberCount?: string } }[];
      };
      const n = Number(j.items?.[0]?.statistics?.subscriberCount);
      // A channel that hides its count returns the field absent, not zero —
      // and reporting nought subscribers for a hidden count is a wrong number,
      // not a missing one.
      if (Number.isFinite(n)) yt = { channelId: c.youtube_channel_id, followers: n };
    } catch {
      /* the tile simply has no YouTube row */
    }
  }

  if (!ig && !fb && !yt) return null;

  /*
   * Today is recorded, and the months are read back.
   *
   * Writing on a page view rather than from a cron is what makes this cost
   * nothing to run: the unique key means the tenth view of the day updates
   * one row rather than adding ten. The trade is honest — a client nobody
   * opens has gaps — and it is the right one here, because the number is only
   * ever looked at on the page that fetches it.
   */
  const [igHistory, fbHistory, ytHistory] = await Promise.all([
    ig ? record(clientId, "instagram", ig.followers) : Promise.resolve([]),
    fb ? record(clientId, "facebook", fb.followers) : Promise.resolve([]),
    yt ? record(clientId, "youtube", yt.followers) : Promise.resolve([]),
  ]);

  return {
    instagram: ig ? { ...ig, ...trend(igHistory, ig.followers) } : null,
    facebook: fb ? { ...fb, ...trend(fbHistory, fb.followers) } : null,
    youtube: yt ? { ...yt, ...trend(ytHistory, yt.followers) } : null,
  };
}

/**
 * Write today's count, and hand back the last twelve months.
 *
 * Best-effort in both directions: a database without the table, or a write
 * that fails, costs the chart and never the number beside it. The page has
 * already got what it came for by the time this runs.
 */
async function record(
  clientId: number,
  platform: PlatformKey,
  followers: number
): Promise<MonthPoint[]> {
  try {
    if (!(await hasTable("audience_snapshots"))) return [];
    await execute(
      `INSERT INTO audience_snapshots (client_id, platform, followers, taken_on)
       VALUES (?,?,?,CURDATE())
       ON DUPLICATE KEY UPDATE followers = VALUES(followers)`,
      [clientId, platform, followers]
    );

    /*
     * Each month's *closing* count, not its average and not its first.
     *
     * "Grew by 40 in July" means where July finished. So the row for a month
     * is the one on the newest day we have for it, found by joining back on
     * that date rather than by an aggregate that would mix months.
     */
    return await query<MonthPoint>(
      `SELECT DATE_FORMAT(s.taken_on, '%Y-%m') AS month, s.followers
         FROM audience_snapshots s
         JOIN (
           SELECT MAX(taken_on) AS last_day
             FROM audience_snapshots
            WHERE client_id = ? AND platform = ?
            GROUP BY DATE_FORMAT(taken_on,'%Y-%m')
            ORDER BY last_day DESC
            LIMIT 12
         ) t ON t.last_day = s.taken_on
        WHERE s.client_id = ? AND s.platform = ?
        ORDER BY s.taken_on ASC`,
      [clientId, platform, clientId, platform]
    );
  } catch (err) {
    console.warn(
      "[audience] could not record the snapshot:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * What the tile draws, from the rows the table holds.
 *
 * `change` is measured against the end of *last* month rather than the first
 * reading of this one, so a month still running reads as "up 40 so far"
 * instead of resetting to nothing on the 1st. Null when there is no earlier
 * month at all — a first reading has no growth to report, and "+0" would
 * claim a flat month nobody watched.
 */
function trend(
  history: MonthPoint[],
  current: number
): { history: MonthPoint[]; change: number | null } {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const previous = history.filter((p) => p.month < thisMonth);
  const last = previous[previous.length - 1];
  return { history, change: last ? current - last.followers : null };
}
