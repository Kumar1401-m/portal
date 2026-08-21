/**
 * How the work actually performed once it was published.
 *
 * The portal has always known what it *made* — planned, approved, posted —
 * and nothing at all about what happened next. That is the half a client
 * actually pays for, and until now the answer to "did it work?" lived in the
 * Instagram app on somebody's phone.
 *
 * Read from Meta and stored, unlike follower counts, which are read live.
 * The difference is deliberate: a follower count has exactly one true value
 * today, but a post's reach is a fact about a day that has passed — once the
 * numbers settle they never change again, and re-fetching a year of posts to
 * draw one chart would be a Graph call per post per page view.
 *
 * Meta keeps revising a post's figures for roughly two days after it goes
 * out, so anything that recent is re-fetched on every sync and everything
 * older is left alone.
 *
 * **`post_insights` was already in the schema.** It has been created by
 * `database/migrate.js` since long before anything read from it, and it holds
 * one row per post *per day* rather than one row per post — so a read today
 * corrects today's figures and a read tomorrow records how the post has grown
 * since. Every query here therefore takes the newest snapshot per media id.
 * Writing a second, flatter table beside it would have been less code today
 * and two versions of the same fact for ever.
 *
 * Never throws outward. A sync that fails returns what it managed, because a
 * board that goes blank when Meta is having a bad morning is worse than one
 * showing yesterday's numbers.
 */
import "server-only";
import type { PlatformKey } from "./audience";
import { query, queryOne, execute, hasTable } from "./db";
import { env } from "./env";
import { onTheFloor } from "./client-status";

const GRAPH = "https://graph.facebook.com";

/** Posts this recent get their numbers re-read; older ones have settled. */
export const SETTLES_AFTER_DAYS = 3;

/** How far back a first sync reaches. Beyond this is history nobody asks for. */
const FIRST_SYNC_DAYS = 120;

export const insightsReady = () => hasTable("post_insights");

export type PostRow = {
  media_id: string;
  permalink: string | null;
  media_type: string;
  caption: string | null;
  posted_at: string | null;
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  views: number;
  client_id: number;
  company_name?: string;
};

/* --------------------------- Pure arithmetic --------------------------- */

/**
 * Engagement as a share of the people who actually saw it.
 *
 * Against reach, not followers. Follower-based engagement rate is the number
 * every social tool quotes and it flatters a small account and punishes a
 * growing one — it answers "how many of my followers reacted", when the
 * question a client is asking is "of the people this reached, how many cared".
 *
 * Null rather than zero when reach is unknown: a post Meta has not reported
 * on yet has no rate, and 0% would read as a failure it did not have.
 */
export function engagementRate(p: {
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
}): number | null {
  if (!p.reach) return null;
  return ((p.likes + p.comments + p.saves + p.shares) / p.reach) * 100;
}

export const interactions = (p: { likes: number; comments: number; saves: number; shares: number }) =>
  p.likes + p.comments + p.saves + p.shares;

/**
 * The best posts, by engagement rate rather than by raw reach.
 *
 * Sorting by reach just lists the posts Meta happened to push hardest, which
 * says more about the algorithm than about the work. Rate is the honest
 * ranking — but a post seen by eleven people can hit 40% on four likes, so
 * anything below a floor of reach is left out of the running rather than
 * allowed to top a chart the whole month gets judged on.
 */
export function rank(posts: PostRow[], limit = 5, minReach = 50): PostRow[] {
  return posts
    .filter((p) => p.reach >= minReach)
    .sort((a, b) => (engagementRate(b) ?? 0) - (engagementRate(a) ?? 0))
    .slice(0, limit);
}

export type Slot = { key: string; posts: number; avgReach: number; avgEngagement: number };

/**
 * Which day of the week, and which hour, this account does best on.
 *
 * Averaged, never totalled: a day the agency posted eight times would win a
 * total every time regardless of how any of them did.
 *
 * A slot needs at least two posts behind it to be offered as advice. One
 * lucky Tuesday is not a pattern, and "post on Tuesdays" is the kind of
 * finding that gets repeated to a client as fact.
 */
export function slots(posts: PostRow[], by: "weekday" | "hour", minPosts = 2): Slot[] {
  const buckets = new Map<string, { reach: number; eng: number; n: number }>();
  for (const p of posts) {
    if (!p.posted_at) continue;
    const d = new Date(p.posted_at.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) continue;
    const key = by === "weekday" ? String(d.getDay()) : String(d.getHours());
    const b = buckets.get(key) ?? { reach: 0, eng: 0, n: 0 };
    b.reach += p.reach;
    b.eng += engagementRate(p) ?? 0;
    b.n += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .filter(([, b]) => b.n >= minPosts)
    .map(([key, b]) => ({
      key,
      posts: b.n,
      avgReach: Math.round(b.reach / b.n),
      avgEngagement: b.eng / b.n,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "3 PM", from the hour bucket key. */
export function hourLabel(hour: string): string {
  const h = Number(hour);
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

/** REELS / IMAGE / CAROUSEL_ALBUM → something a person reads. */
export function formatLabel(mediaType: string): string {
  const t = (mediaType || "").toUpperCase();
  if (t === "REELS" || t === "VIDEO") return "Reel";
  if (t === "CAROUSEL_ALBUM") return "Carousel";
  if (t === "IMAGE") return "Post";
  return t ? t.charAt(0) + t.slice(1).toLowerCase() : "Post";
}

/* ------------------------------ Syncing ------------------------------ */

type ClientRow = {
  id: number;
  company_name: string;
  ig_user_id: string | null;
  ig_access_token: string | null;
};

type Media = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};

/** ISO 8601 from Meta → the DATETIME the rest of the app writes. */
const asDateTime = (iso: string | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};

async function graph<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(
      `${GRAPH}/${env.meta.apiVersion}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(12_000) }
    );
    const json = (await res.json().catch(() => ({}))) as T & { error?: unknown };
    return json.error ? null : json;
  } catch {
    return null;
  }
}

/**
 * Reach, saves and shares for one post.
 *
 * Metrics are not uniform across media types and Meta fails the *whole* call
 * when one of them does not apply — asking a photo for `views` loses its
 * reach too. So the full set is tried once and a bare `reach` is the retry,
 * which is the metric every media type has had for as long as the API has
 * existed.
 */
async function mediaInsights(
  mediaId: string,
  token: string,
  isReel: boolean
): Promise<{ reach: number; saves: number; shares: number; views: number; failed: boolean }> {
  const out = { reach: 0, saves: 0, shares: 0, views: 0, failed: false };
  const wanted = isReel ? "reach,saved,shares,views" : "reach,saved,shares";

  type Insights = { data?: { name?: string; values?: { value?: number }[] }[] };
  const read = (res: Insights | null) => {
    for (const m of res?.data ?? []) {
      const v = Number(m.values?.[0]?.value ?? 0);
      if (m.name === "reach") out.reach = v;
      else if (m.name === "saved") out.saves = v;
      else if (m.name === "shares") out.shares = v;
      else if (m.name === "views") out.views = v;
    }
    return Boolean(res?.data?.length);
  };

  if (read(await graph<Insights>(`/${mediaId}/insights?metric=${wanted}`, token))) return out;

  /*
   * Whether the numbers are real, told apart from whether they are zero.
   *
   * Both calls returning nothing used to leave the same all-zero object a
   * genuinely unseen post leaves, and it was written to the table as fact. A
   * token without `instagram_manage_insights` reads the post list perfectly
   * and is refused every insight — so the board filled up with real captions,
   * real like counts and a reach of zero, and said nothing. There is no way to
   * look at that and know to go and check a permission.
   */
  const bare = await graph<Insights>(`/${mediaId}/insights?metric=reach`, token);
  read(bare);
  out.failed = bare === null;
  return out;
}

export type SyncResult = { ok: boolean; posts: number; error?: string };

/**
 * Pull this client's recent posts and their numbers.
 *
 * One call for the media list, then one per post that still needs its
 * insights — which after the first run is only the handful posted in the last
 * few days. A month-old post is read from the table it was written to.
 */
export async function syncClientPosts(clientId: number): Promise<SyncResult> {
  if (!(await insightsReady())) {
    return { ok: false, posts: 0, error: "The post_insights table isn't in this database yet." };
  }

  const c = await queryOne<ClientRow>(
    "SELECT id, company_name, ig_user_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  if (!c) return { ok: false, posts: 0, error: "No such client." };

  const token = c.ig_access_token || env.meta.accessToken;
  if (!token) return { ok: false, posts: 0, error: "No Meta access token — add one on the client's page." };
  if (!c.ig_user_id) return { ok: false, posts: 0, error: "This client has no Instagram account id set." };

  const list = await graph<{ data?: Media[] }>(
    `/${c.ig_user_id}/media?limit=50&fields=id,caption,media_type,media_product_type,` +
      `permalink,timestamp,like_count,comments_count`,
    token
  );
  if (!list) {
    return { ok: false, posts: 0, error: "Instagram refused the request — check the token on this client." };
  }

  // What we already hold, so a post whose numbers have settled costs nothing.
  const known = new Set(
    (
      await query<{ media_id: string }>(
        "SELECT DISTINCT media_id FROM post_insights WHERE client_id = ?",
        [clientId]
      )
    ).map((r) => r.media_id)
  );

  const cutoff = Date.now() - FIRST_SYNC_DAYS * 86_400_000;
  const settled = Date.now() - SETTLES_AFTER_DAYS * 86_400_000;
  let written = 0;
  /** Posts whose figures Instagram would not hand over. */
  let blind = 0;

  for (const m of list.data ?? []) {
    if (!m.id) continue;
    const postedAt = asDateTime(m.timestamp);
    const postedMs = postedAt ? new Date(postedAt.replace(" ", "T")).getTime() : 0;
    if (postedMs && postedMs < cutoff) continue;

    // Already stored and old enough that Meta has stopped revising it.
    if (known.has(m.id) && postedMs && postedMs < settled) continue;

    const isReel = (m.media_product_type || m.media_type || "").toUpperCase() === "REELS";
    const ins = await mediaInsights(m.id, token, isReel);
    if (ins.failed) {
      blind++;
      // Never overwrite numbers we did read once with zeros we did not. A new
      // post is still stored, so it appears on the board; the count below is
      // what says its figures are missing rather than nil.
      if (known.has(m.id)) continue;
    }

    const likes = Number(m.like_count ?? 0);
    const comments = Number(m.comments_count ?? 0);
    const total = likes + comments + ins.saves + ins.shares;
    // Stored as well as computed on read: the column is in the table, and a
    // stored rate is what makes a post's history readable straight from SQL.
    const rate = ins.reach ? (total / ins.reach) * 100 : 0;

    await execute(
      `INSERT INTO post_insights
         (client_id, deliverable_id, platform, media_id, media_type, permalink, caption,
          published_at, snapshot_date, reach, views, plays, likes, comments, saves, shares,
          total_interactions, engagement_rate)
       VALUES (?,
         (SELECT id FROM (SELECT id FROM deliverables WHERE instagram_media_id = ? LIMIT 1) x),
         'instagram',?,?,?,?,?, CURDATE(), ?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         permalink = VALUES(permalink), caption = VALUES(caption),
         media_type = VALUES(media_type), published_at = VALUES(published_at),
         reach = VALUES(reach), views = VALUES(views), plays = VALUES(plays),
         likes = VALUES(likes), comments = VALUES(comments),
         saves = VALUES(saves), shares = VALUES(shares),
         total_interactions = VALUES(total_interactions),
         engagement_rate = VALUES(engagement_rate),
         /* Never unlink a post from its task: the media id match can fail on a
            later pass (a task deleted, a re-import) and losing the link would
            lose which brief this post came from. */
         deliverable_id = COALESCE(post_insights.deliverable_id, VALUES(deliverable_id))`,
      [
        clientId,
        m.id,
        m.id,
        (m.media_product_type || m.media_type || "").slice(0, 30),
        m.permalink ?? null,
        m.caption?.slice(0, 2000) ?? null,
        postedAt,
        ins.reach,
        ins.views,
        ins.views,
        likes,
        comments,
        ins.saves,
        ins.shares,
        total,
        Number(rate.toFixed(2)),
      ]
    );
    written++;
  }

  if (blind) {
    return {
      ok: false,
      posts: written,
      error:
        `Instagram listed ${blind === written ? "the posts" : `${blind} of the posts`} but refused ` +
        `their reach and engagement. That is a permission, not a bad account: the token this ` +
        `client uses is missing instagram_manage_insights. Clear the token on the client to fall ` +
        `back to the agency one, or reissue it with that scope.`,
    };
  }

  return { ok: true, posts: written };
}

/** Every client on the floor with Instagram set up. Used by the nightly job. */
/** Which client could not be read, and what Instagram said about it. */
export type SyncProblem = { client: string; error: string };

export async function syncAllPosts(): Promise<{
  clients: number;
  posts: number;
  failed: number;
  /*
   * Named, because a bare count is not something anybody can act on.
   *
   * This reported `1 failed` and threw away both the client and the reason,
   * so the Automations page could say a nightly job was failing and never
   * say which account or why — and the reason is nearly always one client's
   * token, which is a two-minute fix once you know whose.
   */
  problems: SyncProblem[];
}> {
  if (!(await insightsReady())) return { clients: 0, posts: 0, failed: 0, problems: [] };
  const clients = await query<{ id: number; company_name: string }>(
    `SELECT c.id, c.company_name FROM clients c
      WHERE ${onTheFloor()} AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''`
  );
  let posts = 0;
  const problems: SyncProblem[] = [];
  for (const c of clients) {
    const r = await syncClientPosts(c.id).catch((e) => ({
      ok: false,
      posts: 0,
      error: e instanceof Error ? e.message : "The sync threw.",
    }) as SyncResult);
    // Counted whether or not the client succeeded: a run that stored eight
    // posts and was refused the ninth wrote eight, and said zero.
    posts += r.posts;
    if (!r.ok) problems.push({ client: c.company_name, error: r.error ?? "Instagram would not answer." });
  }
  return { clients: clients.length, posts, failed: problems.length, problems };
}

/* ------------------------------ Reading ------------------------------ */

export type Totals = {
  posts: number;
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  views: number;
};

const zero = (): Totals => ({ posts: 0, reach: 0, likes: 0, comments: 0, saves: 0, shares: 0, views: 0 });

export function sum(posts: PostRow[]): Totals {
  return posts.reduce((t, p) => {
    t.posts++;
    t.reach += p.reach;
    t.likes += p.likes;
    t.comments += p.comments;
    t.saves += p.saves;
    t.shares += p.shares;
    t.views += p.views;
    return t;
  }, zero());
}

const num = (v: unknown) => Number(v ?? 0);

const mapRow = (r: Record<string, unknown>): PostRow => ({
  media_id: String(r.media_id),
  permalink: r.permalink ? String(r.permalink) : null,
  media_type: String(r.media_type ?? ""),
  caption: r.caption ? String(r.caption) : null,
  posted_at: r.published_at ? String(r.published_at) : null,
  reach: num(r.reach),
  likes: num(r.likes),
  comments: num(r.comments),
  saves: num(r.saves),
  shares: num(r.shares),
  views: num(r.views),
  client_id: num(r.client_id),
  company_name: r.company_name ? String(r.company_name) : undefined,
});

/**
 * Every post in a date range, optionally for one client.
 *
 * `clientIds` is the crm scope: null means unrestricted, an empty array means
 * this user has been assigned nobody and must see nothing — not everything.
 */
export async function getPosts(
  from: string,
  to: string,
  opts: { clientId?: number | null; clientIds?: number[] | null } = {}
): Promise<PostRow[]> {
  if (!(await insightsReady())) return [];
  /*
   * An archived client is off this board, like every other board.
   *
   * Archiving deletes the work and leaves the money — deliberately — but the
   * published numbers sat outside both rules: reach, engagement and a name in
   * "Reach by client" for somebody the agency stopped working with months
   * ago, counted into every roster-wide total. `onTheFloor` is the same test
   * the deliverables boards, my-work and the reminders already apply.
   */
  const where: string[] = [
    onTheFloor("c"),
    "p.published_at >= ?",
    "p.published_at < ? + INTERVAL 1 DAY",
  ];
  const params: (string | number)[] = [from, to];

  if (opts.clientId) {
    where.push("p.client_id = ?");
    params.push(opts.clientId);
  }
  if (opts.clientIds) {
    if (opts.clientIds.length === 0) return [];
    where.push(`p.client_id IN (${opts.clientIds.map(() => "?").join(",")})`);
    params.push(...opts.clientIds);
  }

  /*
   * The newest snapshot of each post, not every snapshot of it.
   *
   * The table records a post once a day for as long as it is being read, so a
   * plain SELECT would count one reel eleven times and multiply the month's
   * reach by however long the sync has been running. The join back on
   * MAX(snapshot_date) is what makes one row mean one post.
   */
  const rows = await query<Record<string, unknown>>(
    `SELECT p.*, c.company_name
       FROM post_insights p
       JOIN clients c ON c.id = p.client_id
       JOIN (SELECT media_id, MAX(snapshot_date) AS latest
               FROM post_insights GROUP BY media_id) last
         ON last.media_id = p.media_id AND last.latest = p.snapshot_date
      WHERE ${where.join(" AND ")}
      ORDER BY p.published_at DESC
      LIMIT 500`,
    params
  );
  return rows.map(mapRow);
}

export type ClientPerformance = {
  client_id: number;
  company_name: string;
  totals: Totals;
  /** Engagement rate across the range, weighted by reach. Null with no reach. */
  rate: number | null;
  followers: number | null;
  /** Followers gained since the end of last month. */
  growth: number | null;
};

/** One line per client — the board, sorted by reach. */
export function byClient(posts: PostRow[]): ClientPerformance[] {
  const map = new Map<number, ClientPerformance>();
  for (const p of posts) {
    const row =
      map.get(p.client_id) ??
      ({
        client_id: p.client_id,
        company_name: p.company_name ?? "—",
        totals: zero(),
        rate: null,
        followers: null,
        growth: null,
      } satisfies ClientPerformance);
    const t = row.totals;
    t.posts++;
    t.reach += p.reach;
    t.likes += p.likes;
    t.comments += p.comments;
    t.saves += p.saves;
    t.shares += p.shares;
    t.views += p.views;
    map.set(p.client_id, row);
  }
  for (const row of map.values()) row.rate = engagementRate(row.totals);
  return [...map.values()].sort((a, b) => b.totals.reach - a.totals.reach);
}

/**
 * Follower count and this month's growth for every client, from the snapshots
 * already on disk.
 *
 * No Graph call. The Analytics board lists every client at once and a live
 * read each would be twenty round trips before the page renders — the ads
 * page fetches live because it shows one client at a time.
 */
/** One account's standing: where it is now, and what it has done this month. */
export type AudienceStanding = { followers: number; growth: number | null };

/**
 * Every client's standing on every platform, in one query.
 *
 * Kept per platform rather than summed. A client with 1,001 on Instagram and
 * 28 on their Page has two facts, and the number that adds them up — 1,029 —
 * is true of no account anybody can open. The board draws them side by side
 * for the same reason: "followers" is not one figure once a client is on
 * three platforms, and a single total hides which one is actually growing.
 *
 * Growth is measured against the close of last month, not the first reading
 * of this one, so a month still running reads as "up 40 so far" rather than
 * resetting on the 1st. Null when there is no earlier month at all — a first
 * reading has no growth, and "+0" would claim a flat month nobody watched.
 */
export async function audienceByPlatform(): Promise<
  Map<number, Partial<Record<PlatformKey, AudienceStanding>>>
> {
  const out = new Map<number, Partial<Record<PlatformKey, AudienceStanding>>>();
  if (!(await hasTable("audience_snapshots"))) return out;

  const rows = await query<Record<string, unknown>>(
    `SELECT s.client_id, s.platform, s.followers,
            s.followers - COALESCE(prev.followers, 0) AS growth,
            prev.followers IS NOT NULL AS had_prev
       FROM audience_snapshots s
       JOIN (
         SELECT client_id, platform, MAX(taken_on) AS latest
           FROM audience_snapshots GROUP BY client_id, platform
       ) last ON last.client_id = s.client_id AND last.platform = s.platform
                 AND last.latest = s.taken_on
       LEFT JOIN audience_snapshots prev
              ON prev.client_id = s.client_id AND prev.platform = s.platform
             AND prev.taken_on = (
               SELECT MAX(taken_on) FROM audience_snapshots q
                WHERE q.client_id = s.client_id AND q.platform = s.platform
                  AND q.taken_on < DATE_FORMAT(CURDATE(), '%Y-%m-01')
             )
       JOIN clients c ON c.id = s.client_id
      -- Same rule as the posts above: an archived client's following is not
      -- part of what the agency currently reaches.
      WHERE ${onTheFloor("c")}`
  ).catch(() => []);

  for (const r of rows) {
    const id = num(r.client_id);
    const platform = String(r.platform) as PlatformKey;
    const entry = out.get(id) ?? {};
    entry[platform] = {
      followers: num(r.followers),
      growth: num(r.had_prev) > 0 ? num(r.growth) : null,
    };
    out.set(id, entry);
  }
  return out;
}

/**
 * The same, narrowed to Instagram.
 *
 * Derived rather than queried again: the posts on this board are Instagram's
 * and so is the follower figure beside them, and two queries against one
 * table are two chances for the two numbers to disagree.
 */
export async function followerBoard(): Promise<Map<number, AudienceStanding>> {
  const all = await audienceByPlatform();
  const out = new Map<number, AudienceStanding>();
  for (const [id, byPlatform] of all) {
    if (byPlatform.instagram) out.set(id, byPlatform.instagram);
  }
  return out;
}

/** When the numbers were last pulled from Meta. */
export async function lastInsightSync(): Promise<string | null> {
  if (!(await insightsReady())) return null;
  const r = await queryOne<{ at: string | null }>("SELECT MAX(updated_at) AS at FROM post_insights");
  return r?.at ?? null;
}
