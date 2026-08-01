/**
 * On-demand Instagram sync — "analyse this client now".
 *
 * The nightly n8n job collects yesterday for everyone. This is the other half:
 * the moment an account is connected, pull its history immediately so the
 * dashboard has something to show, instead of a blank page until tomorrow.
 *
 * It also backfills. Meta serves `reach` and `views` as a day-by-day series
 * when you pass since/until, so one call returns a month of history — which
 * means growth-vs-previous-period works on day one rather than after 60 days
 * of nightly runs. That is the difference between a dashboard someone trusts
 * and one they stop opening.
 *
 * Talks to the Graph API directly rather than through n8n on purpose: a person
 * clicked a button and is waiting for an answer, so there is no queue to hand
 * the work to.
 */
import "server-only";
import { queryOne, execute, hasColumn } from "./db";
import { env } from "./env";
import { saveAccountSnapshot, savePostInsight } from "./analytics";
import { parseMediaInsights, mergeMediaCounts } from "./meta-insights";
import { generateRecommendations } from "./insights-ai";

const API = "https://graph.facebook.com";

/** Meta refuses a since/until span wider than this on insights edges. */
const MAX_BACKFILL_DAYS = 30;

type GraphError = { message?: string; code?: number; type?: string };

async function graph<T = Record<string, unknown>>(
  path: string,
  token: string
): Promise<{ ok: true; data: T } | { ok: false; error: string; code?: number }> {
  const url = `${API}/${env.meta.apiVersion}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = (await res.json()) as { error?: GraphError } & T;
    if (body?.error) {
      return { ok: false, error: body.error.message || "Graph API error", code: body.error.code };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/** The token for a client: its own if set, otherwise the agency-wide one. */
async function tokenFor(clientId: number): Promise<string | null> {
  if (await hasColumn("clients", "ig_access_token")) {
    const row = await queryOne<{ ig_access_token: string | null }>(
      "SELECT ig_access_token FROM clients WHERE id = ?",
      [clientId]
    );
    if (row?.ig_access_token) return row.ig_access_token;
  }
  return env.meta.accessToken || null;
}

/* ------------------------- Resolving what was pasted ------------------------- */

export type ResolvedAccount = {
  igUserId: string;
  username: string | null;
  followers: number;
  mediaCount: number;
  /** True when the value pasted was a Facebook Page id that we translated. */
  correctedFromPageId: boolean;
};

/**
 * Work out the real Instagram Business account id from whatever was pasted.
 *
 * People paste the Facebook **Page** id here constantly — it's the number
 * Meta's own UI shows most prominently, and the two are indistinguishable by
 * eye. The failure it causes is deeply unhelpful: publishing dies with
 * `(#100) Tried accessing nonexisting field (media)`, which names neither the
 * real problem nor the fix.
 *
 * So rather than validate and reject, this translates: if the id turns out to
 * be a Page, follow `instagram_business_account` to the account actually
 * wanted. The caller stores the corrected value.
 */
export async function resolveInstagramAccount(
  pastedId: string,
  token: string
): Promise<{ ok: true; account: ResolvedAccount } | { ok: false; error: string }> {
  const id = pastedId.trim();
  if (!/^\d{5,}$/.test(id)) {
    return { ok: false, error: "That doesn't look like a Meta account id — it should be all digits." };
  }

  // Try it as an Instagram account first: the common case, and one call.
  const asIg = await graph<{ id: string; username?: string; followers_count?: number; media_count?: number }>(
    `/${id}?fields=username,followers_count,media_count`,
    token
  );
  if (asIg.ok && asIg.data.username) {
    return {
      ok: true,
      account: {
        igUserId: asIg.data.id || id,
        username: asIg.data.username ?? null,
        followers: Number(asIg.data.followers_count ?? 0),
        mediaCount: Number(asIg.data.media_count ?? 0),
        correctedFromPageId: false,
      },
    };
  }

  // No `username` field means it isn't an IG account. See if it's a Page with
  // one attached.
  const asPage = await graph<{
    id: string;
    name?: string;
    instagram_business_account?: { id: string; username?: string; followers_count?: number; media_count?: number };
  }>(`/${id}?fields=name,instagram_business_account{id,username,followers_count,media_count}`, token);

  if (asPage.ok && asPage.data.instagram_business_account) {
    const ig = asPage.data.instagram_business_account;
    return {
      ok: true,
      account: {
        igUserId: ig.id,
        username: ig.username ?? null,
        followers: Number(ig.followers_count ?? 0),
        mediaCount: Number(ig.media_count ?? 0),
        correctedFromPageId: true,
      },
    };
  }

  if (asPage.ok) {
    return {
      ok: false,
      error: `"${asPage.data.name || id}" is a Facebook Page with no Instagram Business account linked. Link one in Meta Business Suite, or use the Instagram account id instead.`,
    };
  }

  return {
    ok: false,
    error:
      asIg.ok === false && asIg.code === 190
        ? "The Meta access token has expired or been revoked."
        : `Couldn't read that account: ${!asPage.ok ? asPage.error : "unknown error"}`,
  };
}

/* ------------------------------- Backfilling ------------------------------- */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** One entry of a day-series insight response. */
type DaySeries = { name?: string; values?: { value?: unknown; end_time?: string }[] };

/**
 * Turn a day-series response into a date → value map.
 *
 * Meta stamps each point with `end_time`, which is the START of the following
 * day in UTC — a value labelled 2026-08-02T07:00:00+0000 describes 1 August.
 * Attributing it to the 2nd shifts the entire chart one day left, so the date
 * is stepped back here.
 */
function seriesToMap(entries: DaySeries[], metric: string): Map<string, number> {
  const out = new Map<string, number>();
  const entry = entries.find((e) => (e.name || "").toLowerCase() === metric);
  for (const point of entry?.values || []) {
    if (!point.end_time) continue;
    const ms = Date.parse(point.end_time);
    if (Number.isNaN(ms)) continue;
    const day = iso(new Date(ms - 86400000));
    out.set(day, typeof point.value === "number" ? point.value : 0);
  }
  return out;
}

export type SyncResult = {
  ok: boolean;
  error?: string;
  clientName?: string;
  username?: string | null;
  followers?: number;
  /** Set when a pasted Page id was translated and the client record updated. */
  correctedId?: string;
  daysBackfilled?: number;
  postsStored?: number;
  recommendations?: number;
  /** Non-fatal problems worth showing — usually a missing permission. */
  warnings?: string[];
};

/**
 * Pull everything available for one client and store it.
 *
 * Partial success is the design: a token without `instagram_manage_insights`
 * still yields followers, posts, likes and comments, which is a useful
 * dashboard. Each missing piece becomes a warning naming the permission,
 * rather than failing the whole sync and leaving the page blank.
 */
export async function syncClientAnalytics(
  clientId: number,
  opts: { days?: number; skipRecommendations?: boolean } = {}
): Promise<SyncResult> {
  const days = Math.min(MAX_BACKFILL_DAYS, Math.max(1, opts.days ?? MAX_BACKFILL_DAYS));
  const warnings: string[] = [];

  const client = await queryOne<{ id: number; company_name: string; ig_user_id: string | null }>(
    "SELECT id, company_name, ig_user_id FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return { ok: false, error: "Client not found." };
  if (!client.ig_user_id) {
    return { ok: false, error: "This client has no Instagram account id yet. Add one on the client's edit page." };
  }

  const token = await tokenFor(clientId);
  if (!token) {
    return {
      ok: false,
      error:
        "No Meta access token is configured. Set META_ACCESS_TOKEN, or give this client its own token on its edit page.",
    };
  }

  // Resolve first: a stored Page id is corrected here rather than failing
  // every call downstream with an unhelpful message.
  const resolved = await resolveInstagramAccount(client.ig_user_id, token);
  if (!resolved.ok) return { ok: false, error: resolved.error, clientName: client.company_name };

  const account = resolved.account;
  let correctedId: string | undefined;
  if (account.correctedFromPageId || account.igUserId !== client.ig_user_id) {
    await execute("UPDATE clients SET ig_user_id = ? WHERE id = ?", [account.igUserId, clientId]);
    correctedId = account.igUserId;
  }
  if (account.username && (await hasColumn("clients", "ig_username"))) {
    await execute("UPDATE clients SET ig_username = ? WHERE id = ?", [account.username, clientId]);
  }

  const ig = account.igUserId;
  const now = new Date();
  // Yesterday is the last complete day; today is still accumulating and would
  // land as an artificial trough at the end of every chart.
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000);
  const since = new Date(until.getTime() - (days - 1) * 86400000);

  /* ---- Day-by-day history: this is what makes growth work immediately ---- */
  const daily = await graph<{ data?: DaySeries[] }>(
    `/${ig}/insights?metric=reach,views&period=day&since=${unix(since)}&until=${unix(until) + 86399}`,
    token
  );

  const reachByDay = daily.ok ? seriesToMap(daily.data.data || [], "reach") : new Map<string, number>();
  const viewsByDay = daily.ok ? seriesToMap(daily.data.data || [], "views") : new Map<string, number>();
  if (!daily.ok) {
    warnings.push(
      daily.code === 10 || daily.code === 100
        ? "Reach and views need the `instagram_manage_insights` permission — add it to the Meta token and sync again."
        : `Daily history unavailable: ${daily.error}`
    );
  }

  const followersByDay = await (async () => {
    const r = await graph<{ data?: DaySeries[] }>(
      `/${ig}/insights?metric=follower_count&period=day&since=${unix(since)}&until=${unix(until) + 86399}`,
      token
    );
    // Silent when unavailable: Meta refuses follower_count below 100 followers,
    // which is a fact about the account, not a misconfiguration.
    return r.ok ? seriesToMap(r.data.data || [], "follower_count") : new Map<string, number>();
  })();

  /* ---- Write one row per day ---- */
  const allDays = new Set<string>([...reachByDay.keys(), ...viewsByDay.keys(), ...followersByDay.keys()]);
  // Always write today's row, even with no insight data, so the follower count
  // and post metrics below have somewhere to live.
  allDays.add(iso(until));

  let daysBackfilled = 0;
  for (const day of [...allDays].sort()) {
    const isLatest = day === iso(until);
    await saveAccountSnapshot({
      clientId,
      date: day,
      // A running total, only known for "now" — writing it on historical rows
      // would draw a flat line at today's value across the whole month.
      followers: isLatest ? account.followers : 0,
      followerDelta: followersByDay.get(day) ?? 0,
      reach: reachByDay.get(day) ?? 0,
      views: viewsByDay.get(day) ?? 0,
    });
    daysBackfilled++;
  }

  /* ---- Posts ---- */
  const media = await graph<{
    data?: {
      id: string;
      media_type?: string;
      media_product_type?: string;
      permalink?: string;
      thumbnail_url?: string;
      media_url?: string;
      caption?: string;
      timestamp?: string;
      like_count?: number;
      comments_count?: number;
    }[];
  }>(
    `/${ig}/media?fields=id,media_type,media_product_type,permalink,thumbnail_url,media_url,caption,timestamp,like_count,comments_count&limit=50`,
    token
  );

  let postsStored = 0;
  let postInsightFailures = 0;
  const today = iso(new Date());

  if (!media.ok) {
    warnings.push(`Couldn't read posts: ${media.error}`);
  } else {
    for (const m of media.data.data || []) {
      const ins = await graph<{ data?: DaySeries[] }>(
        `/${m.id}/insights?metric=reach,views,likes,comments,shares,saved`,
        token
      );
      if (!ins.ok) postInsightFailures++;

      const parsed = mergeMediaCounts(
        parseMediaInsights(ins.ok ? (ins.data as never) : null),
        m
      );

      await savePostInsight({
        clientId,
        mediaId: m.id,
        date: today,
        mediaType: m.media_product_type || m.media_type || null,
        permalink: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url || m.media_url || null,
        caption: m.caption ?? null,
        publishedAt: m.timestamp ?? null,
        reach: parsed.reach,
        views: parsed.views,
        plays: parsed.plays,
        likes: parsed.likes,
        comments: parsed.comments,
        shares: parsed.shares,
        saves: parsed.saves,
        totalInteractions: parsed.totalInteractions,
        raw: ins.ok ? ins.data : null,
      });
      postsStored++;
    }

    if (postInsightFailures > 0 && postInsightFailures === postsStored) {
      warnings.push(
        "Per-post reach and saves need the `instagram_manage_insights` permission — likes and comments were stored, the rest are zero."
      );
    }
  }

  /* ---- Recommendations, from whatever we just stored ---- */
  let recommendations = 0;
  if (!opts.skipRecommendations && postsStored > 0) {
    try {
      const recs = await generateRecommendations(clientId, {
        from: iso(new Date(Date.now() - 365 * 86400000)),
        to: today,
        platform: "instagram",
      });
      recommendations = recs.length;
    } catch (err) {
      // Advice is the least important part of a sync; never fail it for this.
      warnings.push(
        `Recommendations couldn't be generated: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  return {
    ok: true,
    clientName: client.company_name,
    username: account.username,
    followers: account.followers,
    correctedId,
    daysBackfilled,
    postsStored,
    recommendations,
    warnings,
  };
}
