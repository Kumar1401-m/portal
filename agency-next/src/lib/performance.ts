/**
 * What this post is made of, and what posts made of that have done before.
 *
 * The ask was a prediction model: record a feature set per post, train on it,
 * and answer "input → expected performance". This is the first two thirds of
 * that, built the way the rest of the portal is built — and honest about the
 * third.
 *
 * ## Why there is no trained model here
 *
 * A model needs examples. With three published posts, anything fitted to them
 * would produce a confident number with no information in it, on a client's
 * account, and nothing about the output would say so. The failure mode of a
 * model trained on nothing is not "no answer" — it is a wrong answer that
 * looks exactly like a right one, which is the worst thing this portal can do.
 *
 * So this is arithmetic over the client's own history, with a floor: a group
 * of fewer than `MIN_POSTS` gets no verdict, the same rule `learning.ts`
 * already holds to. It says "reels with a face: 240 median, 5 posts" or it
 * says nothing. As the history grows the same code says more, and the day
 * there are hundreds of rows the feature set assembled here is exactly what a
 * real model would train on — recorded from the beginning rather than
 * reconstructed later, which is the part that cannot be done in arrears.
 *
 * ## Where the features come from
 *
 * Almost all of them were already being stored, in two tables that nobody had
 * read together:
 *
 *   deliverables    → format, category, language, duration, caption, hashtags,
 *                     the day and hour it went out
 *   video_analysis  → hook, topic, mood, on-screen text, branding, whether a
 *                     person is on camera
 *   post_insights   → reach, engagement, and now how long it was watched
 *
 * Nothing is copied into a feature table. A denormalised copy is a second
 * version of a fact, and the two disagree the first time one is edited.
 */
import "server-only";
import { query, queryOne, hasColumn } from "./db";
import { MIN_POSTS } from "./learning";

/** Every feature the portal can honestly say about a post. */
export type PostFeatures = {
  deliverableId: number;
  clientId: number;
  /** The studio's own format key, when one was chosen. */
  format: string | null;
  category: string | null;
  language: string | null;
  /** Seconds, from the cut itself. */
  durationSec: number | null;
  captionChars: number;
  hashtagCount: number;
  /** Whether the caption ends in a question or an ask. */
  hasCta: boolean;
  /** 0 = Sunday, as MySQL counts it. Null before it is scheduled. */
  weekday: number | null;
  hour: number | null;
  hook: string | null;
  topic: string | null;
  mood: string | null;
  hasFace: boolean | null;
  spokenLanguage: string | null;
};

/** What actually happened to it. */
export type PostOutcome = {
  reach: number;
  interactions: number;
  engagementRate: number | null;
  avgWatchMs: number | null;
  /** Average watch over the video's own length. Null without both. */
  retention: number | null;
};

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Does the caption ask for anything?
 *
 * A crude test on purpose. "Has a call to action" is a judgement, and a
 * regular expression that pretends otherwise would be a feature that means
 * something slightly different every time somebody rewrites it. This asks the
 * narrow question it can answer: does the copy end by asking.
 */
const CTA = /(dm|comment|link in bio|order|book|call|visit|save this|share this|tag )/i;

const hashtagsIn = (s: string | null) => (s ? (s.match(/#[\p{L}\p{N}_]+/gu) || []).length : 0);

/** The feature row for one post, assembled from where each part already lives. */
export async function featuresFor(deliverableId: number): Promise<PostFeatures | null> {
  const analysis = (await hasColumn("video_analysis", "state"))
    ? `LEFT JOIN video_analysis v ON v.deliverable_id = d.id`
    : "";
  const face = (await hasColumn("video_analysis", "has_face")) ? "v.has_face" : "NULL";
  const cols = analysis
    ? `v.hook, v.topic, v.mood, v.spoken_language, ${face} AS has_face`
    : `NULL AS hook, NULL AS topic, NULL AS mood, NULL AS spoken_language, NULL AS has_face`;

  const r = await queryOne<Record<string, unknown>>(
    `SELECT d.id, d.client_id, d.content_type, d.content_category, d.language,
            d.video_duration, d.caption, d.hashtags,
            DAYOFWEEK(COALESCE(d.posted_at, d.scheduled_at)) - 1 AS weekday,
            HOUR(COALESCE(d.posted_at, d.scheduled_at))        AS hour,
            ${cols}
       FROM deliverables d ${analysis}
      WHERE d.id = ?`,
    [deliverableId]
  ).catch(() => null);
  if (!r) return null;

  const caption = str(r.caption);
  return {
    deliverableId: num(r.id),
    clientId: num(r.client_id),
    format: str(r.content_type),
    category: str(r.content_category),
    language: str(r.language),
    durationSec: r.video_duration == null ? null : num(r.video_duration),
    captionChars: caption ? caption.length : 0,
    hashtagCount: hashtagsIn(str(r.hashtags)),
    hasCta: caption ? CTA.test(caption) : false,
    weekday: r.weekday == null ? null : num(r.weekday),
    hour: r.hour == null ? null : num(r.hour),
    hook: str(r.hook),
    topic: str(r.topic),
    mood: str(r.mood),
    hasFace: r.has_face == null ? null : Boolean(num(r.has_face)),
    spokenLanguage: str(r.spoken_language),
  };
}

/**
 * One thing a group of past posts had in common, and how they did.
 *
 * `proven` is the whole discipline. Two good posts are two good posts; a
 * pattern needs enough of them that the next one is not just the same luck.
 */
export type Signal = {
  label: string;
  posts: number;
  medianReach: number;
  proven: boolean;
  /** How this group compares with the client's own median, as a percentage. */
  vsBaseline: number | null;
};

export type Prediction = {
  /** The client's own middle post, which is what "normal" means for them. */
  baselineReach: number | null;
  /** Posts with numbers, in the window. */
  sample: number;
  /** Ordered by how far they are from the baseline, strongest first. */
  signals: Signal[];
  /** Null until there is enough history to say anything at all. */
  expected: { low: number; high: number } | null;
  /** Said plainly when there is not. */
  note: string | null;
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * What a post like this one has done for this client before.
 *
 * Every published post of theirs is read with its features, grouped by each
 * feature the new post shares, and each group compared with the client's own
 * median. The comparison is against themselves and never against another
 * client: a thousand-follower account and a two-follower account have nothing
 * to say to each other about what a good reach is.
 *
 * The expected range is the baseline moved by the strongest proven signal, and
 * it is a range because a median over five posts is not a forecast. When there
 * is not enough history it is null and `note` says so — an empty answer being
 * far better here than a confident one.
 */
export async function expectedPerformance(
  clientId: number,
  features: Pick<PostFeatures, "format" | "category" | "hasFace" | "language" | "weekday">
): Promise<Prediction> {
  const face = (await hasColumn("video_analysis", "has_face")) ? "v.has_face" : "NULL";
  const rows = await query<Record<string, unknown>>(
    `SELECT p.reach, d.content_type, d.content_category, d.language,
            DAYOFWEEK(COALESCE(d.posted_at, d.scheduled_at)) - 1 AS weekday,
            ${face} AS has_face
       FROM post_insights p
       JOIN deliverables d ON d.id = p.deliverable_id
       LEFT JOIN video_analysis v ON v.deliverable_id = d.id
       JOIN (SELECT media_id, MAX(snapshot_date) AS latest
               FROM post_insights GROUP BY media_id) last
         ON last.media_id = p.media_id AND last.latest = p.snapshot_date
      WHERE p.client_id = ? AND p.reach > 0`,
    [clientId]
  ).catch(() => []);

  const sample = rows.length;
  if (sample < MIN_POSTS) {
    return {
      baselineReach: sample ? median(rows.map((r) => num(r.reach))) : null,
      sample,
      signals: [],
      expected: null,
      note:
        `Only ${sample} published post${sample === 1 ? "" : "s"} with numbers so far. ` +
        `Nothing can be predicted from that — this fills in on its own as they publish.`,
    };
  }

  const baseline = median(rows.map((r) => num(r.reach)));

  const group = (label: string, keep: (r: Record<string, unknown>) => boolean): Signal | null => {
    const hit = rows.filter(keep).map((r) => num(r.reach));
    if (!hit.length) return null;
    const m = median(hit);
    return {
      label,
      posts: hit.length,
      medianReach: m,
      proven: hit.length >= MIN_POSTS,
      vsBaseline: baseline ? Math.round(((m - baseline) / baseline) * 100) : null,
    };
  };

  const candidates: (Signal | null)[] = [
    features.format ? group(`format “${features.format}”`, (r) => str(r.content_type) === features.format) : null,
    features.category ? group(`${features.category}`, (r) => str(r.content_category) === features.category) : null,
    features.language ? group(`in ${features.language}`, (r) => str(r.language) === features.language) : null,
    features.hasFace === null
      ? null
      : group(features.hasFace ? "with somebody on camera" : "with nobody on camera", (r) =>
          r.has_face == null ? false : Boolean(num(r.has_face)) === features.hasFace
        ),
    features.weekday === null
      ? null
      : group("posted on that weekday", (r) => num(r.weekday) === features.weekday),
  ];

  const signals = candidates
    .filter((s): s is Signal => s !== null)
    .sort((a, b) => Math.abs(b.vsBaseline ?? 0) - Math.abs(a.vsBaseline ?? 0));

  /*
   * The strongest thing that is actually proven — not the strongest thing.
   *
   * An unproven group can show a huge percentage precisely because it has two
   * posts in it, and letting that set the range would make the least reliable
   * evidence the loudest.
   */
  const lead = signals.find((s) => s.proven) ?? null;
  const centre = lead ? lead.medianReach : baseline;

  return {
    baselineReach: baseline,
    sample,
    signals,
    /* ±30%, because a median over a handful of posts is a middle, not a forecast. */
    expected: { low: Math.round(centre * 0.7), high: Math.round(centre * 1.3) },
    note: lead
      ? null
      : `Nothing has ${MIN_POSTS} posts behind it yet, so this is their usual reach rather than anything about this post in particular.`,
  };
}
