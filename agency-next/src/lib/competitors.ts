/**
 * The accounts a client is measured against.
 *
 * Read through Meta's **business discovery**, which is the supported way to
 * look at another public business or creator account: the client's own
 * Instagram id and token ask about a handle, and Meta returns that account's
 * follower count and recent posts. Nothing is scraped, nothing is seen that a
 * client could not see by opening the app themselves, and no private account
 * can be read at all — Meta simply refuses.
 *
 * That refusal is worth knowing before anybody adds a rival: personal accounts,
 * private accounts and anything not a Business or Creator profile return an
 * error, and the error is stored and shown rather than swallowed into an empty
 * comparison that looks like a competitor doing nothing.
 *
 * **Trends live here too, and honestly.** The portal has no access to a
 * trending-topics feed, and inventing one would be the single easiest way to
 * make this whole system untrustworthy. What it has instead is real: what a
 * client's rivals actually posted lately, what did well for them, and which of
 * those subjects the client has not touched. That is a content gap, it is
 * evidence-backed, and it is what "trending for this client" honestly means.
 */
import "server-only";
import { query, queryOne, execute, hasTable } from "./db";
import { env } from "./env";
import { callJSON } from "./ai";
import { buildBrief } from "./content-ai";
import type { Comparison, Gap } from "./comment-kinds";
export type { Comparison, Gap };

const GRAPH = "https://graph.facebook.com";

export const competitorsReady = () => hasTable("competitors");

export type CompetitorPost = {
  caption: string;
  likes: number;
  comments: number;
  type: string;
  timestamp: string | null;
};

export type Competitor = {
  id: number;
  clientId: number;
  handle: string;
  label: string | null;
  followers: number | null;
  mediaCount: number | null;
  posts: CompetitorPost[];
  checkedAt: string | null;
  lastError: string | null;
};

const num = (v: unknown) => (v == null ? null : Number(v));

function mapRow(r: Record<string, unknown>): Competitor {
  const raw = r.snapshot_json;
  const snap = (typeof raw === "string" ? safeParse(raw) : (raw as Record<string, unknown> | null)) ?? {};
  return {
    id: Number(r.id),
    clientId: Number(r.client_id),
    handle: String(r.handle),
    label: r.label ? String(r.label) : null,
    followers: num(r.followers),
    mediaCount: num(r.media_count),
    posts: Array.isArray(snap.posts) ? (snap.posts as CompetitorPost[]) : [],
    checkedAt: r.checked_at ? String(r.checked_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
  };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function listCompetitors(clientId: number): Promise<Competitor[]> {
  if (!(await competitorsReady())) return [];
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM competitors WHERE client_id = ? ORDER BY followers IS NULL, followers DESC, handle",
    [clientId]
  ).catch(() => []);
  return rows.map(mapRow);
}

export async function addCompetitor(
  clientId: number,
  handle: string,
  label: string | null,
  addedBy: number
): Promise<{ ok: boolean; error?: string }> {
  if (!(await competitorsReady())) {
    return { ok: false, error: "The competitors table isn't in this database yet." };
  }
  // Handles only. Somebody will paste a full profile URL, and the @ is habit.
  const clean = handle
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/[/?].*$/, "")
    .replace(/^@+/, "")
    .toLowerCase();

  if (!/^[a-z0-9._]{1,30}$/.test(clean)) {
    return { ok: false, error: "That doesn't look like an Instagram handle." };
  }

  await execute(
    `INSERT INTO competitors (client_id, handle, label, added_by) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
    [clientId, clean, label?.slice(0, 150) || null, addedBy]
  );
  return { ok: true };
}

export async function removeCompetitor(clientId: number, id: number): Promise<void> {
  await execute("DELETE FROM competitors WHERE id = ? AND client_id = ?", [id, clientId]);
}

/**
 * Read one competitor through the client's own account.
 *
 * Business discovery is a field on the *client's* Instagram node, not a
 * separate endpoint — which is also why it needs the client to have Instagram
 * properly connected before any of this works.
 */
export async function refreshCompetitor(clientId: number, competitorId: number): Promise<{ ok: boolean; error?: string }> {
  const client = await queryOne<{ ig_user_id: string | null; ig_access_token: string | null }>(
    "SELECT ig_user_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  const token = client?.ig_access_token || env.meta.accessToken;
  if (!client?.ig_user_id || !token) {
    return { ok: false, error: "This client has no connected Instagram account to look through." };
  }

  const row = await queryOne<{ handle: string }>(
    "SELECT handle FROM competitors WHERE id = ? AND client_id = ?",
    [competitorId, clientId]
  );
  if (!row) return { ok: false, error: "No such competitor." };

  const fields =
    `business_discovery.username(${row.handle})` +
    `{followers_count,media_count,media.limit(12){caption,like_count,comments_count,media_product_type,media_type,timestamp}}`;

  let payload: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(
      `${GRAPH}/${env.meta.apiVersion}/${client.ig_user_id}?fields=${encodeURIComponent(fields)}` +
        `&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(12_000) }
    );
    const json = (await res.json().catch(() => ({}))) as {
      business_discovery?: Record<string, unknown>;
      error?: { message?: string; code?: number };
    };
    if (json.error) {
      /*
       * Meta's own message, translated where it is misleading.
       *
       * The common failure is not "you lack a permission" — it is that the
       * handle belongs to a personal account, which business discovery cannot
       * read at all. Sending somebody to check their app permissions for that
       * is an hour wasted.
       */
      const m = json.error.message ?? "Instagram refused the request.";
      error = /cannot be found|does not exist|not.*business/i.test(m)
        ? `@${row.handle} can't be read — business discovery only sees public Business and Creator accounts, never personal or private ones.`
        : m;
    } else {
      payload = json.business_discovery ?? null;
      if (!payload) error = `Instagram returned nothing for @${row.handle}.`;
    }
  } catch {
    error = "Couldn't reach Instagram.";
  }

  if (error) {
    await execute("UPDATE competitors SET last_error = ?, checked_at = NOW() WHERE id = ?", [
      error.slice(0, 400),
      competitorId,
    ]);
    return { ok: false, error };
  }

  const media = (payload?.media as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];
  const posts: CompetitorPost[] = media.map((m) => ({
    caption: String(m.caption ?? "").slice(0, 300),
    likes: Number(m.like_count ?? 0),
    comments: Number(m.comments_count ?? 0),
    type: String(m.media_product_type ?? m.media_type ?? ""),
    timestamp: m.timestamp ? String(m.timestamp) : null,
  }));

  await execute(
    `UPDATE competitors
        SET followers = ?, media_count = ?, snapshot_json = ?, checked_at = NOW(), last_error = NULL
      WHERE id = ?`,
    [
      Number(payload?.followers_count ?? 0) || null,
      Number(payload?.media_count ?? 0) || null,
      JSON.stringify({ posts }),
      competitorId,
    ]
  );
  return { ok: true };
}

/* ------------------------------ Comparison ------------------------------ */

/** Posts per week from a set of timestamps, or null when there are too few. */
export function postsPerWeek(posts: CompetitorPost[]): number | null {
  const times = posts
    .map((p) => (p.timestamp ? Date.parse(p.timestamp) : NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  const spanDays = (times[times.length - 1] - times[0]) / 86_400_000;
  if (spanDays < 1) return null;
  return Math.round(((times.length / spanDays) * 7) * 10) / 10;
}

export function compareOne(c: Competitor): Comparison {
  const engaged = c.posts.length
    ? c.posts.reduce((t, p) => t + p.likes + p.comments, 0) / c.posts.length
    : null;
  return {
    handle: c.handle,
    label: c.label,
    followers: c.followers,
    perWeek: postsPerWeek(c.posts),
    avgEngagement: engaged === null ? null : Math.round(engaged),
    // Against followers, because a competitor's reach is not public. Said on
    // the page, since it is a different measure from the client's own rate,
    // which is against reach — comparing the two directly would be wrong.
    ratePerFollower:
      engaged === null || !c.followers ? null : Math.round((engaged / c.followers) * 1000) / 10,
    checkedAt: c.checkedAt,
    error: c.lastError,
  };
}

/**
 * What the rivals are doing that this client is not.
 *
 * The numbers are computed here and handed over; the model's job is to read
 * the two sets of captions and name the subjects one side covers and the other
 * does not. That is genuinely a language task — "they post about post-surgery
 * recovery and you never do" cannot be got at by counting — and it is the only
 * part of this file a model touches.
 *
 * Returns null rather than a guess when there is nothing to compare.
 */
export async function findGaps(clientId: number): Promise<Gap[] | null> {
  const [brief, competitors] = await Promise.all([
    buildBrief(clientId),
    listCompetitors(clientId),
  ]);
  if (!brief) return null;

  const withPosts = competitors.filter((c) => c.posts.length >= 3);
  if (!withPosts.length) return null;

  const theirs = withPosts
    .map((c) => {
      const cmp = compareOne(c);
      return [
        `@${c.handle}${c.label ? ` (${c.label})` : ""} — ${c.followers ?? "?"} followers, ` +
          `${cmp.perWeek ?? "?"} posts a week, ${cmp.avgEngagement ?? "?"} average likes+comments.`,
        ...c.posts.slice(0, 8).map((p) => `   · "${p.caption.split("\n")[0].slice(0, 110)}" (${p.likes} likes)`),
      ].join("\n");
    })
    .join("\n\n");

  const { data } = await callJSON(
    [
      "You compare a business's own social content with its named competitors and find the gaps.",
      "A gap is a subject or format the competitors cover and this client does not — say which, and cite it.",
      "Never suggest 'post more' or 'engage with your audience'. Every suggestion must be a specific piece of content.",
      "If the competitors are doing nothing this client is not, say so in one gap rather than inventing three.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `THIS CLIENT\n${brief.context}`,
      brief.performance.length
        ? `WHAT ALREADY WORKS FOR THEM\n${brief.performance.map((p) => `- ${p}`).join("\n")}`
        : "WHAT ALREADY WORKS FOR THEM\nNot enough published history yet.",
      `THEIR COMPETITORS' RECENT POSTS\n${theirs}`,
      brief.rules ?? "",
      "",
      'Reply as JSON: { "gaps": [{"headline":"short","detail":"what they do and this client does not, with the evidence","suggestion":"one specific piece of content to make"}] }',
      "Three to five gaps.",
    ]
      .filter(Boolean)
      .join("\n\n")
  ).catch(() => ({ data: null }));

  if (!data || !Array.isArray(data.gaps)) return null;
  const gaps = (data.gaps as Record<string, unknown>[])
    .map((g) => ({
      headline: String(g.headline ?? "").trim(),
      detail: String(g.detail ?? "").trim(),
      suggestion: String(g.suggestion ?? "").trim(),
    }))
    .filter((g) => g.headline);

  return gaps.length ? gaps : null;
}
