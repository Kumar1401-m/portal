/**
 * The step that turns a pile of features into a loop.
 *
 *   data → decision → automation → action → result → LEARNING → next decision
 *
 * Everything except the last arrow already existed. The portal could decide
 * what to make (the studio), turn that into work (idea → task), get it made
 * and posted (the board and the publisher), and measure what happened
 * (`post_insights`). What it could not do was carry the measurement back to
 * the decision — so every month it made the same decisions with the same
 * confidence, whatever the results had been.
 *
 * The missing link was small and it was a record, not an algorithm: nothing
 * wrote down WHICH KIND of thing was made. A post could be traced to its task,
 * and the task said "Instagram Reel" — the taxonomy the boards run on — but
 * not whether it was a myths reel or a rapid fire or a festival poster. Those
 * are the decisions the studio actually makes, and they were thrown away at
 * the moment the task was created.
 *
 * So the format key is recorded on the task, and this reads it back:
 *
 *     deliverables.content_type → post_insights.deliverable_id → reach, engagement
 *
 * ## Why `content_type`
 *
 * It is a `varchar(60)` on `deliverables` that the app has never read or
 * written — inherited from the old Express schema. Using it means the loop
 * works the moment this ships rather than waiting for a migration to be
 * applied by hand, which is the difference between a feature and a plan.
 *
 * The price is that old rows may hold values from that earlier life, so every
 * read here is filtered to the keys the portal actually issues. Anything else
 * in that column is somebody else's data and is ignored rather than reported
 * as a format nobody recognises.
 *
 * ## What it refuses to say
 *
 * The same discipline as `brain.ts`: this does arithmetic and the model only
 * narrates it. A format with fewer than three published posts gets no verdict,
 * because two good posts are two good posts and not a pattern — and a
 * confident sentence about a format an agency will now make more of is exactly
 * where a plausible number does real damage.
 */
import "server-only";
import { query } from "./db";
import { hasTable } from "./db";
import { ALL_FORMAT_KEYS, formatLabelFor } from "./content-kinds";

/** Posts a format needs before it is allowed a verdict. */
export const MIN_POSTS = 3;

export type FormatResult = {
  key: string;
  label: string;
  /** Published posts made in this format, inside the window. */
  posts: number;
  avgReach: number;
  /** Mean engagement rate across those posts, as a percentage. */
  avgEngagement: number;
  /**
   * How this format did against the client's own average, as a multiple.
   * 1.4 means "forty per cent better than this account's typical post".
   */
  lift: number;
  /** 0–95. Sample size and effect size, never asked of a model. */
  confidence: number;
  /** True once there is enough here to act on. */
  proven: boolean;
};

export type Learned = {
  clientId: number;
  months: number;
  /** Every format tried, best first. */
  formats: FormatResult[];
  /** The client's own mean engagement rate — what `lift` is measured against. */
  baseline: number;
  /** Published posts that could be traced back to a recorded format. */
  measured: number;
  /** Published posts in the window, traced or not. */
  total: number;
};

/**
 * Confidence, from the two things that actually determine it.
 *
 * Sample first: three posts is thin, ten is a pattern, and nothing beyond
 * about a dozen adds much for an account posting a few times a week. Then the
 * size of the effect — a format 3× the average needs less evidence to be worth
 * acting on than one 5% ahead, which is noise wearing a decimal point.
 *
 * Capped at 95. Nothing measured from an Instagram account is ever certain.
 */
function confidenceFrom(posts: number, lift: number): number {
  const bySample = Math.min(60, posts * 6);
  const byEffect = Math.min(35, Math.abs(lift - 1) * 45);
  return Math.round(Math.min(95, bySample + byEffect));
}

/**
 * What each format has actually earned for one client.
 *
 * One row per post, newest snapshot only — `post_insights` stores a post again
 * every day it is read, so without the join back on the latest snapshot a post
 * synced for a fortnight would be counted fourteen times and a format's
 * average would be an average of nothing.
 */
export async function learned(clientId: number, months = 6): Promise<Learned> {
  const empty: Learned = {
    clientId,
    months,
    formats: [],
    baseline: 0,
    measured: 0,
    total: 0,
  };
  if (!(await hasTable("post_insights"))) return empty;

  const rows = await query<{
    key: string | null;
    reach: number;
    rate: number;
  }>(
    `SELECT d.content_type AS \`key\`,
            p.reach        AS reach,
            p.engagement_rate AS rate
       FROM post_insights p
       JOIN (SELECT media_id, MAX(snapshot_date) AS latest
               FROM post_insights GROUP BY media_id) last
         ON last.media_id = p.media_id AND last.latest = p.snapshot_date
       LEFT JOIN deliverables d ON d.id = p.deliverable_id
      WHERE p.client_id = ?
        AND p.published_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)`,
    [clientId, Math.max(1, Math.min(24, Math.round(months)))]
  ).catch(() => []);

  if (!rows.length) return empty;

  const num = (v: unknown) => Number(v ?? 0);
  const all = rows.map((r) => ({
    key: r.key && ALL_FORMAT_KEYS.includes(r.key) ? r.key : null,
    reach: num(r.reach),
    rate: num(r.rate),
  }));

  /*
   * The baseline is every post, not only the ones with a format on them.
   *
   * "Better than average" has to mean better than what this account normally
   * does. Measuring against the average of only the formatted posts would make
   * the first format ever recorded score exactly 1.0 by construction, and the
   * comparison would be with itself.
   */
  const baseline = all.reduce((t, p) => t + p.rate, 0) / all.length;

  const groups = new Map<string, { reach: number; rate: number; n: number }>();
  for (const p of all) {
    if (!p.key) continue;
    const g = groups.get(p.key) ?? { reach: 0, rate: 0, n: 0 };
    g.reach += p.reach;
    g.rate += p.rate;
    g.n += 1;
    groups.set(p.key, g);
  }

  const formats: FormatResult[] = [...groups.entries()]
    .map(([key, g]) => {
      const avgEngagement = g.rate / g.n;
      const lift = baseline > 0 ? avgEngagement / baseline : 0;
      return {
        key,
        label: formatLabelFor(key),
        posts: g.n,
        avgReach: Math.round(g.reach / g.n),
        avgEngagement,
        lift,
        confidence: confidenceFrom(g.n, lift),
        proven: g.n >= MIN_POSTS,
      };
    })
    .sort((a, b) => b.lift - a.lift);

  return {
    clientId,
    months,
    formats,
    baseline,
    measured: formats.reduce((t, f) => t + f.posts, 0),
    total: all.length,
  };
}

/**
 * What the studio is told, in sentences it can act on.
 *
 * Only proven formats, and the strongest and weakest rather than a table —
 * a model handed nine rows of numbers will do arithmetic on them, badly. Two
 * plain facts are what actually change the next thing it writes.
 */
export function learnedLines(l: Learned): string[] {
  const proven = l.formats.filter((f) => f.proven);
  if (!proven.length) {
    if (l.measured > 0) {
      return [
        `Only ${l.measured} published posts so far carry a format, so no format has ` +
          `${MIN_POSTS} yet. Do not claim one works better than another.`,
      ];
    }
    return [];
  }

  const out: string[] = [];
  const best = proven[0];
  const worst = proven[proven.length - 1];
  const pct = (f: FormatResult) => `${f.avgEngagement.toFixed(1)}%`;

  if (best.lift >= 1.15) {
    out.push(
      `${best.label} is this account's strongest format: ${pct(best)} average engagement ` +
        `across ${best.posts} posts, ${best.lift.toFixed(1)}× the account's own average. ` +
        `Lean towards it.`
    );
  } else {
    out.push(
      `No format is clearly ahead yet — the best, ${best.label}, is only ` +
        `${best.lift.toFixed(1)}× the account's average across ${best.posts} posts.`
    );
  }

  if (proven.length >= 2 && worst.lift <= 0.85) {
    out.push(
      `${worst.label} is the weakest: ${pct(worst)} across ${worst.posts} posts, ` +
        `${worst.lift.toFixed(1)}× the average. Do not suggest more of it without a reason.`
    );
  }

  // Formats never tried are worth naming: a loop that only reinforces what it
  // has already measured stops finding anything new.
  const tried = new Set(l.formats.map((f) => f.key));
  const untried = ALL_FORMAT_KEYS.filter((k) => !tried.has(k)).map(formatLabelFor);
  if (untried.length) {
    out.push(`Never tried for this client: ${untried.join(", ")}.`);
  }
  return out;
}

/**
 * What to make next.
 *
 * The proven leader when there is one — and otherwise something untried,
 * deliberately. An account with nothing proven does not need the portal's
 * best guess repeated; it needs another data point, and the cheapest way to
 * get one is to make a format nobody has tried yet.
 */
export function nextFormat(l: Learned): { key: string; label: string; why: string } | null {
  const proven = l.formats.filter((f) => f.proven);
  const best = proven[0];
  if (best && best.lift >= 1.15) {
    return {
      key: best.key,
      label: best.label,
      why:
        `${best.avgEngagement.toFixed(1)}% average engagement across ${best.posts} posts, ` +
        `${best.lift.toFixed(1)}× this account's average.`,
    };
  }

  const tried = new Set(l.formats.map((f) => f.key));
  const untried = ALL_FORMAT_KEYS.find((k) => !tried.has(k));
  if (untried) {
    return {
      key: untried,
      label: formatLabelFor(untried),
      why:
        l.measured > 0
          ? `Nothing is clearly ahead yet, and this one has never been tried for this client.`
          : `No results to learn from yet — this is a starting point, not a recommendation.`,
    };
  }
  return best ? { key: best.key, label: best.label, why: `The best of what has been tried.` } : null;
}
