/**
 * AI-powered recommendations from a client's Instagram history.
 *
 * Two layers, in this order:
 *
 *   1. Statistics. Best posting time, best content type and the engagement
 *      picture are computed from `post_insights` — they are facts about what
 *      already happened, and an LLM asked to "find the best time" would only
 *      be guessing at them.
 *   2. Language. The model turns those figures into advice a client can read,
 *      and adds the genuinely generative part (hashtag suggestions).
 *
 * Layer 2 is optional. With no API key configured every recommendation still
 * comes out, written from the same numbers — the dashboard is never blank
 * because a key is missing.
 */
import "server-only";
import { query, queryOne, execute, hasColumn } from "./db";
import { callJSON } from "./ai";
import {
  getTimingPerformance,
  getContentTypePerformance,
  getComparedTotals,
  getTopPosts,
  type AnalyticsFilters,
} from "./analytics";

export type InsightKind = "best_time" | "content_type" | "hashtags" | "engagement";

export type Recommendation = {
  kind: InsightKind;
  headline: string;
  detail: string;
  /** 0..1 — how much data stands behind it. Rendered as a "based on N posts" hint. */
  confidence: number;
  evidence: Record<string, unknown>;
};

const DAY_NAMES = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hourLabel = (h: number) => {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
};

const pct = (v: number) => `${v.toFixed(1)}%`;
const num = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v));

/**
 * Confidence from sample size, saturating at 20 posts.
 *
 * Three posts in a slot is a coincidence; twenty is a pattern. Expressing that
 * as a number keeps the UI from presenting a fluke with the same certainty as
 * a trend.
 */
const confidenceFromSample = (posts: number) => Math.min(1, Math.round((posts / 20) * 100) / 100);

/* ------------------------------ Layer 1: statistics ------------------------------ */

/**
 * Best posting time.
 *
 * Slots with only one post are ignored — a single lucky reel would otherwise
 * become "always post at 3 AM on Tuesday". Ranked by average engagement rate,
 * with reach as the tie-break.
 */
function bestTimeRecommendation(
  timing: Awaited<ReturnType<typeof getTimingPerformance>>
): Recommendation | null {
  const usable = timing.filter((t) => t.posts >= 2);
  const pool = usable.length ? usable : timing;
  if (!pool.length) return null;

  const best = [...pool].sort(
    (a, b) => b.avgEngagementRate - a.avgEngagementRate || b.avgReach - a.avgReach
  )[0];
  const sample = pool.reduce((sum, t) => sum + t.posts, 0);

  // The day on its own is a more robust signal than the exact hour, so it's
  // reported separately rather than folded into one over-precise slot.
  const byDay = new Map<number, { posts: number; erSum: number }>();
  for (const t of pool) {
    const cur = byDay.get(t.dayOfWeek) || { posts: 0, erSum: 0 };
    cur.posts += t.posts;
    cur.erSum += t.avgEngagementRate * t.posts;
    byDay.set(t.dayOfWeek, cur);
  }
  const bestDay = [...byDay.entries()]
    .map(([dow, v]) => ({ dow, er: v.erSum / Math.max(1, v.posts), posts: v.posts }))
    .sort((a, b) => b.er - a.er)[0];

  return {
    kind: "best_time",
    headline: `Post around ${hourLabel(best.hour)} on ${DAY_NAMES[best.dayOfWeek] || "weekdays"}`,
    detail:
      `Posts published in that slot averaged ${pct(best.avgEngagementRate)} engagement and ` +
      `${num(best.avgReach)} reach, across ${best.posts} post${best.posts === 1 ? "" : "s"}. ` +
      (bestDay
        ? `${DAY_NAMES[bestDay.dow]} is the strongest day overall (${pct(bestDay.er)} average engagement).`
        : ""),
    confidence: confidenceFromSample(sample),
    evidence: {
      best_hour: best.hour,
      best_day_of_week: best.dayOfWeek,
      avg_engagement_rate: best.avgEngagementRate,
      avg_reach: best.avgReach,
      sample_posts: sample,
    },
  };
}

/** Which content category earns the most engagement, and by how much. */
function contentTypeRecommendation(
  types: Awaited<ReturnType<typeof getContentTypePerformance>>
): Recommendation | null {
  const usable = types.filter((t) => t.posts >= 2);
  const pool = usable.length ? usable : types;
  if (!pool.length) return null;

  const ranked = [...pool].sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const sample = pool.reduce((s, t) => s + t.posts, 0);

  const comparison =
    ranked.length > 1 && worst.avgEngagementRate > 0
      ? ` That is ${(best.avgEngagementRate / worst.avgEngagementRate).toFixed(1)}× the engagement of ${worst.label} (${pct(worst.avgEngagementRate)}).`
      : "";

  return {
    kind: "content_type",
    headline: `${best.label} is your strongest format`,
    detail:
      `${best.posts} ${best.label} post${best.posts === 1 ? "" : "s"} averaged ${pct(best.avgEngagementRate)} ` +
      `engagement and ${num(best.avgReach)} reach.${comparison} Weight the next content calendar towards it.`,
    confidence: confidenceFromSample(sample),
    evidence: { ranking: ranked.slice(0, 5), sample_posts: sample },
  };
}

/**
 * Engagement direction, read off the period-over-period comparison. Names the
 * metric that moved most, because "engagement is down 4%" is not actionable
 * while "saves fell 40% while reach held" is.
 */
function engagementRecommendation(
  compared: Awaited<ReturnType<typeof getComparedTotals>>
): Recommendation | null {
  const { current, previous, growth } = compared;
  if (!current.reach && !previous.reach) return null;

  const watched: { label: string; key: keyof typeof growth }[] = [
    { label: "reach", key: "reach" },
    { label: "saves", key: "saves" },
    { label: "shares", key: "shares" },
    { label: "comments", key: "comments" },
    { label: "profile visits", key: "profileVisits" },
  ];
  const moves = watched
    .map((w) => ({ ...w, change: growth[w.key] }))
    .filter((w): w is typeof w & { change: number } => typeof w.change === "number")
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const biggest = moves[0];
  const rising = current.engagementRate >= previous.engagementRate;

  // Saves and shares are distribution signals — Instagram treats them as
  // stronger intent than a like, so they get called out by name.
  const advice = rising
    ? "Keep the current mix and increase frequency before changing the formula."
    : "Lead with a stronger first-three-seconds hook and end on a direct question — saves and shares move the algorithm far more than likes.";

  return {
    kind: "engagement",
    headline: rising
      ? `Engagement is up at ${pct(current.engagementRate)}`
      : `Engagement is at ${pct(current.engagementRate)} — worth a change`,
    detail:
      `Engagement rate moved from ${pct(previous.engagementRate)} to ${pct(current.engagementRate)} ` +
      `on ${num(current.reach)} reach.` +
      (biggest
        ? ` The biggest shift was ${biggest.label}, ${biggest.change >= 0 ? "up" : "down"} ${Math.abs(biggest.change).toFixed(1)}%.`
        : "") +
      ` ${advice}`,
    confidence: current.postsCount ? confidenceFromSample(current.postsCount) : 0.4,
    evidence: {
      current_engagement_rate: current.engagementRate,
      previous_engagement_rate: previous.engagementRate,
      movers: moves.slice(0, 3),
    },
  };
}

/**
 * Hashtag suggestions.
 *
 * Without a model this reports which tags actually appeared on the client's
 * best-performing posts — useful on its own, and the evidence the LLM is given
 * when one is configured.
 */
function hashtagRecommendation(
  topPosts: Awaited<ReturnType<typeof getTopPosts>>
): Recommendation | null {
  if (!topPosts.length) return null;

  const scored = new Map<string, { uses: number; erSum: number }>();
  for (const p of topPosts) {
    const tags = (p.caption || "").match(/#[\p{L}\p{N}_]+/gu) || [];
    for (const raw of new Set(tags.map((t) => t.toLowerCase()))) {
      const cur = scored.get(raw) || { uses: 0, erSum: 0 };
      cur.uses += 1;
      cur.erSum += p.engagementRate;
      scored.set(raw, cur);
    }
  }

  const ranked = [...scored.entries()]
    .map(([tag, v]) => ({ tag, uses: v.uses, avgEr: v.erSum / v.uses }))
    .sort((a, b) => b.avgEr - a.avgEr || b.uses - a.uses)
    .slice(0, 12);

  if (!ranked.length) {
    return {
      kind: "hashtags",
      headline: "Start tagging posts consistently",
      detail:
        "None of the top posts in this period carried hashtags, so there is nothing to learn from yet. " +
        "Use 8–12 per post: three broad, five niche to the business, and two location tags.",
      confidence: 0.3,
      evidence: { top_posts_scanned: topPosts.length, tags_found: 0 },
    };
  }

  return {
    kind: "hashtags",
    headline: `Lead with ${ranked[0].tag}`,
    detail:
      `Across the best-performing posts, ${ranked
        .slice(0, 5)
        .map((r) => r.tag)
        .join(", ")} sat on the highest engagement. ` +
      "Keep 8–12 tags per post and rotate the niche ones so the set doesn't go stale.",
    confidence: confidenceFromSample(topPosts.length),
    evidence: { ranked_tags: ranked, top_posts_scanned: topPosts.length },
  };
}

/* ------------------------------ Layer 2: the model ------------------------------ */

const SYSTEM_PROMPT = `You are a senior Instagram strategist at a digital marketing agency.
You are given REAL performance figures for one client. Rewrite the supplied findings as
specific, confident advice the client's account manager can act on this week.

Rules:
- Never invent numbers. Only use figures present in the input.
- Be concrete: name the format, the slot, the tag, the change to make.
- Two sentences maximum per "detail". No preamble, no hedging, no emoji.
- For hashtags, suggest 10-12 tags: mix broad, niche and local, informed by the
  business type and the tags that already performed.

Reply with JSON only:
{"best_time":{"headline":"","detail":""},
 "content_type":{"headline":"","detail":""},
 "hashtags":{"headline":"","detail":"","tags":["#..."]},
 "engagement":{"headline":"","detail":""}}`;

/**
 * Let the model rewrite the computed findings. Any field it omits or mangles
 * keeps its statistical version, so a partial response degrades one card
 * rather than the whole set.
 */
async function polishWithModel(
  recs: Recommendation[],
  context: { clientName: string; businessType: string | null }
): Promise<Recommendation[]> {
  const userPrompt = JSON.stringify({
    client: context.clientName,
    business_type: context.businessType,
    findings: recs.map((r) => ({
      kind: r.kind,
      current_headline: r.headline,
      current_detail: r.detail,
      evidence: r.evidence,
    })),
  });

  const { data } = await callJSON(SYSTEM_PROMPT, userPrompt);
  if (!data) return recs;

  return recs.map((r) => {
    const patch = data[r.kind] as { headline?: string; detail?: string; tags?: string[] } | undefined;
    if (!patch || typeof patch !== "object") return r;

    const headline = typeof patch.headline === "string" && patch.headline.trim() ? patch.headline.trim() : r.headline;
    let detail = typeof patch.detail === "string" && patch.detail.trim() ? patch.detail.trim() : r.detail;

    // The tag list is the one thing worth generating outright, so it's
    // appended to whatever the model wrote rather than left in the evidence.
    if (r.kind === "hashtags" && Array.isArray(patch.tags)) {
      const tags = patch.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => (t.startsWith("#") ? t : `#${t}`))
        .slice(0, 12);
      if (tags.length) detail = `${detail}\n\nSuggested set: ${tags.join(" ")}`;
    }

    return { ...r, headline: headline.slice(0, 250), detail };
  });
}

/* ------------------------------ Orchestration ------------------------------ */

/**
 * Build the full recommendation set for one client and store it.
 * Called by the daily n8n job; also available as a "refresh" action in the UI.
 */
export async function generateRecommendations(
  clientId: number,
  f: Omit<AnalyticsFilters, "clientId">
): Promise<Recommendation[]> {
  const filters: AnalyticsFilters = { ...f, clientId };

  const [timing, types, compared, topPosts, client] = await Promise.all([
    getTimingPerformance(filters),
    getContentTypePerformance(filters),
    getComparedTotals(filters),
    getTopPosts(filters, 20),
    queryOne<{ company_name: string; business_type: string | null }>(
      "SELECT company_name, business_type FROM clients WHERE id = ?",
      [clientId]
    ),
  ]);

  const base = [
    bestTimeRecommendation(timing),
    contentTypeRecommendation(types),
    hashtagRecommendation(topPosts),
    engagementRecommendation(compared),
  ].filter((r): r is Recommendation => r !== null);

  if (!base.length) return [];

  const polished = await polishWithModel(base, {
    clientName: client?.company_name || "the client",
    businessType: client?.business_type ?? null,
  });

  await saveRecommendations(clientId, polished, f.from, f.to, f.platform || "instagram");
  return polished;
}

/** Persist the set, one row per kind (upserted, so it refreshes in place). */
export async function saveRecommendations(
  clientId: number,
  recs: Recommendation[],
  periodStart: string,
  periodEnd: string,
  platform = "instagram"
): Promise<void> {
  for (const r of recs) {
    await execute(
      `INSERT INTO ai_insights
         (client_id, platform, kind, headline, detail, confidence, evidence_json,
          period_start, period_end, generated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         headline = VALUES(headline), detail = VALUES(detail),
         confidence = VALUES(confidence), evidence_json = VALUES(evidence_json),
         period_start = VALUES(period_start), period_end = VALUES(period_end),
         generated_at = NOW()`,
      [
        clientId,
        platform,
        r.kind,
        r.headline.slice(0, 250),
        r.detail,
        r.confidence,
        JSON.stringify(r.evidence),
        periodStart,
        periodEnd,
      ]
    );
  }
}

export type StoredInsight = {
  kind: InsightKind;
  headline: string;
  detail: string | null;
  confidence: number;
  period_start: string | null;
  period_end: string | null;
  generated_at: string;
};

/** Read back the cached set for the dashboard. */
export async function getRecommendations(
  clientId: number,
  platform = "instagram"
): Promise<StoredInsight[]> {
  if (!(await hasColumn("clients", "ig_username"))) return [];
  try {
    return await query<StoredInsight>(
      `SELECT kind, headline, detail, confidence, period_start, period_end, generated_at
         FROM ai_insights
        WHERE client_id = ? AND platform = ?
        ORDER BY FIELD(kind,'best_time','content_type','hashtags','engagement')`,
      [clientId, platform]
    );
  } catch {
    // The table arrives with the analytics migration; before that, no insights.
    return [];
  }
}
