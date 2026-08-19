/**
 * The content studio — strategy, ideas, scripts, thumbnails and SEO.
 *
 * Five tools, one brief. They are built together and not as five features
 * because they all need exactly the same three things, and a version of any
 * of them that lacks those three writes the same generic post an agency could
 * have got from a free chatbot:
 *
 *   1. **Who the client is** — the record, their bio, their website, gathered
 *      by `client-context.ts`.
 *   2. **What they will and will not say** — the brand knowledge, written
 *      down by whoever runs the account. Facts brief the model; rules bind it.
 *   3. **What has already worked for them** — the real reach and engagement
 *      of their own last sixty days, from `analytics.ts`.
 *
 * The third is the one that makes this different from asking a chatbot for
 * "10 reel ideas". An idea here comes back with the reason it was suggested,
 * and the reason is a number from the client's own account.
 *
 * **Every tool degrades rather than lies.** No model key, a refused request, a
 * malformed reply — each returns `null` and the page says so. Nothing here
 * invents a fallback script, because a plausible script nobody asked for is
 * worse than an empty panel: it gets used.
 */
import "server-only";
import { queryOne, execute, hasTable } from "./db";
import { callJSON } from "./ai";
import { getClientContext, renderContext, renderKnowledgeRules } from "./client-context";
import {
  getPosts,
  rank,
  slots,
  sum,
  engagementRate,
  formatLabel,
  hourLabel,
  WEEKDAYS,
} from "./analytics";
import { shiftMonth, thisMonthKey } from "./date-range";
// The shapes live next door, where the studio — a client component — can
// reach them without pulling the database driver into the browser bundle.
// Re-exported so a server caller still has one import for the subject.
import {
  type ScriptLanguage,
  type Strategy,
  type Idea,
  type ScriptInput,
  type Script,
  type ScriptSection,
  type ThumbnailConcept,
  type SeoPack,
  ENGAGEMENT_ASKS,
  CONTENT_TYPES,
  POSTER_KINDS,
  contentType,
  posterKind,
  type PosterIdea,
  scriptPlan,
  wordFloor,
  countWords,
} from "./content-kinds";
import { learned, learnedLines } from "./learning";
export * from "./content-kinds";

/** How far back "what already worked" reaches. */
const HISTORY_MONTHS = 3;

export type ContentBrief = {
  clientId: number;
  client: string;
  /** Everything known about the business, as briefing material. */
  context: string;
  /** The client's own rules, as requirements. Null when nobody wrote any. */
  rules: string | null;
  /** What their own account rewards, in plain sentences. Empty when unknown. */
  performance: string[];
  /**
   * What the portal's own past decisions earned — see `learning.ts`. Empty
   * until enough posts made from a recorded format have results.
   */
  lessons: string[];
  /** True when there is enough history for the performance lines to mean anything. */
  grounded: boolean;
};

/**
 * Everything the five tools are given.
 *
 * The performance lines are sentences rather than figures because they are
 * handed to a model, and "reels reach 3.4× further than photos" is a fact it
 * can act on where a table of numbers invites it to do arithmetic it is bad at.
 */
export async function buildBrief(clientId: number): Promise<ContentBrief | null> {
  const ctx = await getClientContext(clientId);
  if (!ctx) return null;

  const from = `${shiftMonth(thisMonthKey(), -HISTORY_MONTHS)}-01`;
  const to = new Date().toISOString().slice(0, 10);
  const posts = await getPosts(from, to, { clientId }).catch(() => []);

  const performance: string[] = [];
  // Six posts is the floor for saying anything about a pattern. Below it the
  // tools still run — they simply are not told a story that is not there.
  const grounded = posts.length >= 6;

  if (grounded) {
    const byFormat = new Map<string, typeof posts>();
    for (const p of posts) {
      const key = formatLabel(p.media_type);
      byFormat.set(key, [...(byFormat.get(key) ?? []), p]);
    }
    const formats = [...byFormat.entries()]
      .map(([format, group]) => ({
        format,
        posts: group.length,
        avgReach: Math.round(sum(group).reach / group.length),
        rate: engagementRate(sum(group)),
      }))
      .sort((a, b) => b.avgReach - a.avgReach);

    if (formats.length >= 2 && formats[formats.length - 1].avgReach > 0) {
      const best = formats[0];
      const worst = formats[formats.length - 1];
      const ratio = best.avgReach / worst.avgReach;
      performance.push(
        `${best.format}s reach ${ratio.toFixed(1)}× further than ${worst.format.toLowerCase()}s ` +
          `(${best.avgReach} against ${worst.avgReach} average reach).`
      );
    } else if (formats.length === 1) {
      performance.push(`Everything posted lately has been a ${formats[0].format.toLowerCase()}.`);
    }

    const days = slots(posts, "weekday");
    if (days.length) {
      performance.push(
        `${WEEKDAYS[Number(days[0].key)]} is the strongest day — ` +
          `${days[0].avgEngagement.toFixed(1)}% average engagement across ${days[0].posts} posts.`
      );
    }
    const hours = slots(posts, "hour");
    if (hours.length) {
      performance.push(`Posts going out around ${hourLabel(hours[0].key)} do best.`);
    }

    const top = rank(posts, 5);
    if (top.length) {
      performance.push(
        `Their best posts lately: ` +
          top
            .map(
              (p) =>
                `"${(p.caption?.split("\n")[0] ?? "untitled").slice(0, 70)}" ` +
                `(${formatLabel(p.media_type)}, ${p.reach} reached, ${(engagementRate(p) ?? 0).toFixed(1)}% engaged)`
            )
            .join("; ") +
          "."
      );
    }

    const weak = [...posts].filter((p) => p.reach >= 50).sort((a, b) => (engagementRate(a) ?? 0) - (engagementRate(b) ?? 0));
    if (weak.length >= 3) {
      performance.push(
        `Their weakest lately: ` +
          weak
            .slice(0, 3)
            .map((p) => `"${(p.caption?.split("\n")[0] ?? "untitled").slice(0, 60)}" (${formatLabel(p.media_type)})`)
            .join("; ") +
          ". Do not repeat these shapes."
      );
    }
  }

  /*
   * What the loop has learned, on top of what the raw numbers say.
   *
   * `performance` above is about media types and posting times — facts about
   * the account. These are about the portal's own decisions: which of the
   * formats it chose actually earned anything. That is the arrow that closes
   * the loop, and it is the reason a brief written in March is not the same
   * brief written in September.
   */
  const memory = await learned(clientId).catch(() => null);
  const lessons = memory ? learnedLines(memory) : [];

  return {
    clientId,
    client: ctx.name,
    context: renderContext(ctx),
    rules: renderKnowledgeRules(ctx),
    performance,
    lessons,
    grounded,
  };
}

/** The block every tool's prompt opens with. */
function briefBlock(b: ContentBrief): string {
  return [
    `WHAT WE KNOW ABOUT THE CLIENT\n${b.context}`,
    b.performance.length
      ? `WHAT ALREADY WORKS FOR THIS ACCOUNT (their own last ${HISTORY_MONTHS} months)\n` +
        b.performance.map((p) => `- ${p}`).join("\n")
      : `WHAT ALREADY WORKS FOR THIS ACCOUNT\nNot enough published history yet. Do not claim a pattern; ` +
        `suggest what suits the business and say so plainly.`,
    // The loop's own memory, kept separate from the account's raw numbers:
    // these are results of decisions this portal made, which is what makes
    // this month's advice different from last month's.
    b.lessons.length
      ? `WHAT WE HAVE LEARNED FROM WHAT WE MADE (measured, not guessed)\n` +
        b.lessons.map((l) => `- ${l}`).join("\n")
      : "",
    b.rules ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One place that calls the model, so every tool inherits the same guarantees.
 *
 * The rules block is repeated at the end of the user prompt as well as
 * appearing in the brief. Position matters in a long prompt — the instructions
 * nearest the output contract are the ones actually followed — and these are
 * the ones a client holds the agency to.
 */
async function generate(
  b: ContentBrief,
  system: string,
  task: string
): Promise<Record<string, unknown> | null> {
  const user = [
    briefBlock(b),
    task,
    b.rules ? `Before you answer, re-read the client's rules above. They are not optional.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data } = await callJSON(system, user).catch(() => ({ data: null }));
  return data;
}

const asStr = (v: unknown): string => (v == null ? "" : String(v).trim());
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asStr).filter(Boolean) : asStr(v) ? [asStr(v)] : [];

/* ------------------------------ 1. Strategy ------------------------------ */

/**
 * The month's shape: what to talk about, in what proportion, and why.
 *
 * Pillars with a share rather than a list of topics. "40% educational" is a
 * decision somebody can hold the month against; twelve topics is a to-do list
 * that stops meaning anything the moment one of them is swapped.
 */
export async function contentStrategy(clientId: number, month = thisMonthKey()): Promise<Strategy | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const data = await generate(
    b,
    [
      "You are the content strategist at a digital-marketing agency, planning one client's month.",
      "Ground every recommendation in what the brief says already works for THIS account.",
      "Where the brief says there is not enough history, say so in the reasoning rather than inventing a pattern.",
      "Be concrete and specific to this business. Never give advice that would fit any client.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `Plan ${b.client}'s content for ${month}.`,
      "",
      "Reply as JSON:",
      "{",
      '  "summary": "2-3 sentences: what this month should achieve and why",',
      '  "pillars": [{"name":"Educational","share":"40%","why":"grounded reason from the data above"}],',
      '  "frequency": "how many posts, over how many days",',
      '  "formats": ["Reels", "Carousels"],',
      '  "posting_plan": ["Week 1 — ...", "Week 2 — ..."]',
      "}",
      "",
      "Three to five pillars. Shares must add to 100%.",
    ].join("\n")
  );
  if (!data) return null;

  return {
    month,
    summary: asStr(data.summary),
    pillars: Array.isArray(data.pillars)
      ? (data.pillars as Record<string, unknown>[]).map((p) => ({
          name: asStr(p.name),
          share: asStr(p.share),
          why: asStr(p.why),
        }))
      : [],
    frequency: asStr(data.frequency),
    formats: asList(data.formats),
    postingPlan: asList(data.posting_plan),
    grounded: b.grounded,
  };
}

/* ------------------------------- 2. Ideas ------------------------------- */

/**
 * Ideas, each carrying the reason it was suggested.
 *
 * The reason is the point. "Post about knee pain" is worth nothing; "post
 * about knee pain, because your three best reels this quarter were all
 * single-symptom explainers" is a decision somebody can agree or disagree
 * with. A tool that cannot say why is a random topic generator.
 */
export async function contentIdeas(clientId: number, count = 10): Promise<Idea[] | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const n = Math.min(20, Math.max(3, count));
  const data = await generate(
    b,
    [
      "You generate content ideas for a digital-marketing agency's client.",
      "Every idea must be specific to this business — never one that would fit any account.",
      "The 'why' must cite something from the brief: a format that reaches further, a day that performs, a post that did well.",
      "Do not repeat the topics of the client's recent posts listed in the brief; find the gaps.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `Give ${n} content ideas for ${b.client}.`,
      "",
      // The type is what the loop records and measures, so it has to come back
      // as one of these exact keys rather than as a description of one.
      `Every idea must name its type, exactly one of these keys:`,
      CONTENT_TYPES.map((t) => `  ${t.key} — ${t.label}: ${t.what}`).join("\n"),
      "",
      "Reply as JSON:",
      '{ "ideas": [{',
      '  "topic": "the subject in a few words",',
      '  "hook": "the first line, as it would be spoken or shown",',
      '  "type": "one of the keys above",',
      '  "format": "Reel | Carousel | Post | Story",',
      '  "audience": "who this one is for",',
      '  "cta": "the call to action",',
      '  "why": "the reason, citing the data above",',
      '  "potential": "high | medium | low"',
      "}] }",
    ].join("\n")
  );
  if (!data || !Array.isArray(data.ideas)) return null;

  return (data.ideas as Record<string, unknown>[]).map((i) => {
    // Falls back to the default rather than storing whatever came back — an
    // unrecognised key would be recorded and then silently ignored by every
    // read, which looks exactly like a format that never performs.
    const kind = contentType(asStr(i.type));
    return {
      topic: asStr(i.topic),
      hook: asStr(i.hook),
      type: kind.key,
      typeLabel: kind.label,
      format: asStr(i.format) || "Reel",
      audience: asStr(i.audience),
      cta: asStr(i.cta),
      why: asStr(i.why),
      potential: asStr(i.potential).toLowerCase() || "medium",
    };
  });
}

/* ------------------------------ 3. Scripts ------------------------------ */

const LANGUAGE_RULE: Record<ScriptLanguage, string> = {
  English: "Write in plain English.",
  Telugu: "Write in Telugu, in Telugu script. Natural spoken Telugu, not translated English.",
  // The way people actually talk here, and the one a model gets wrong by
  // defaulting to formal Telugu or to English with a few words swapped.
  Tenglish:
    "Write in Tenglish — Telugu spoken naturally but written in the Roman alphabet, " +
    "mixing in the English words people genuinely use in conversation. Not formal Telugu, " +
    "not English with Telugu words dropped in.",
};

export async function generateScript(clientId: number, input: ScriptInput): Promise<Script | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const seconds = Math.min(180, Math.max(10, input.seconds ?? 40));
  const language = (input.language ?? "English") as ScriptLanguage;
  // The format is picked first, because everything below follows from it: how
  // the body is built, how long the ending runs, and what it asks for.
  const kind = contentType(input.type);

  const plan = scriptPlan(seconds, kind.key);
  const target = plan.reduce((t, s) => t + s.targetWords, 0);
  const floor = wordFloor(seconds, kind.key);

  /*
   * A per-section budget, in seconds and in words.
   *
   * The old prompt said "about N words in total, stay near it" and a 60-second
   * ask reliably came back as 30 seconds of speech. One total is easy for a
   * model to under-shoot and impossible for it to check itself against; five
   * numbered slots with their own clocks are not, and the length rule below is
   * repeated as a hard floor rather than a preference.
   */
  const budget = plan
    .map(
      (s) =>
        `- ${s.label}: seconds ${s.from}–${s.to} (${s.to - s.from}s), at least ${s.targetWords} words`
    )
    .join("\n");

  const system = [
    "You write short-video scripts for a digital-marketing agency's client.",
    kind.key === "graphic"
      ? "This one is not spoken: the words go on screen as cards, so write lines that can be read at a glance."
      : "The script is spoken aloud by the business owner or their presenter — write words a person can say, not prose.",
    LANGUAGE_RULE[language] ?? LANGUAGE_RULE.English,
    "A script has exactly three parts: HOOK, BODY, CALL TO ACTION. No introduction and no separate examples section — an example belongs inside the body.",
    "The hook is the first three seconds and decides whether anything else is watched.",
    "The body carries everything: the substance, the steps, the reasons and any example.",
    // The one line that stops every format coming out as the same reel with a
    // different subject in it.
    `THIS ONE IS A ${kind.label.toUpperCase()} — ${kind.what} Build the body like this: ${kind.shape}`,
    "LENGTH IS A REQUIREMENT, NOT A GUIDE. Every section must reach at least the words given for it.",
    "Going over is fine — an editor can trim. Coming in under is a failure: it leaves the video short on the day of the shoot.",
    "Reply with JSON only.",
  ].join(" ");

  /*
   * One ask, chosen by the format.
   *
   * Asking for all four in ten seconds gets none of them — it is the ending
   * every account runs and the reason "like, share, save, comment, follow"
   * reads as noise. Each format has earned exactly one: a lesson earns a save,
   * a joke earns a share, a ranking earns an argument in the comments, and an
   * ad has bought the second it is standing on, so it asks for the enquiry and
   * nothing else.
   */
  const ctaRule = [
    "THE CALL TO ACTION — one ask, and only one:",
    kind.ask === "direct"
      ? "- This is an ad. The only ask is the client's own action from their rules above — call, DM, book, walk in. " +
        `Do not ask for a ${ENGAGEMENT_ASKS.join(", a ")}: this second is paid for and none of them is the enquiry.`
      : `- Ask for a ${kind.ask.toUpperCase()} and nothing else. Naming all of ` +
        `${ENGAGEMENT_ASKS.join(", ")} in one breath is how an ending gets none of them.`,
    `- Why this one: ${kind.askWhy}`,
    "- Give the reason in the viewer's own terms, tied to what they have just watched. An ask without a reason is skipped.",
    kind.ask === "comment"
      ? "- The prompt must be a real question or word somebody can answer in three words."
      : "",
    kind.ask === "direct"
      ? ""
      : "- The client's own call to action, if their rules give one, comes last on its own line.",
  ]
    .filter(Boolean)
    .join("\n");

  const ask = (extra?: string) =>
    [
      `Write a ${seconds}-second ${kind.label.toLowerCase()} for ${b.client}, for ${input.platform || "Instagram Reels"}.`,
      `Topic: ${input.topic}`,
      input.audience ? `Audience: ${input.audience}` : "",
      input.tone ? `Tone: ${input.tone}` : "",
      input.objective ? `What it should achieve: ${input.objective}` : "",
      "",
      `THE CLOCK — ${seconds} seconds, at least ${target} words in total:`,
      budget,
      "",
      `Build the body the way a ${kind.label.toLowerCase()} is built: ${kind.shape}`,
      "Fill it with actual substance — the detail somebody would stay to hear. Do not pad the hook to reach the count.",
      "",
      ctaRule,
      extra ?? "",
      "",
      "Reply as JSON:",
      "{",
      '  "hook": "the opening line",',
      '  "body": "everything of substance, built the way this format is built — by far the longest section",',
      '  "cta": "the closing section: the one ask with its reason, then the client\'s own CTA",',
      '  "full": "the whole script as it would be read aloud, in order",',
      '  "alt_hooks": ["two or three other openings"]',
      "}",
    ]
      .filter(Boolean)
      .join("\n");

  const build = (data: Record<string, unknown>): Script => {
    const s: Script = {
      hook: asStr(data.hook),
      body: asStr(data.body),
      cta: asStr(data.cta),
      full: asStr(data.full),
      altHooks: asList(data.alt_hooks),
      segments: [],
      totalWords: 0,
      targetWords: target,
      short: false,
    };
    // A model that fills the sections but forgets the whole is common enough
    // to handle here rather than showing an empty script beside five full
    // parts. Rebuilt from the sections either way, so `full` always agrees
    // with what is displayed above it.
    s.full = [s.hook, s.body, s.cta].filter(Boolean).join("\n\n");
    return measure(s, plan, floor);
  };

  const first = await generate(b, system, ask());
  if (!first) return null;
  let script = build(first);

  /*
   * Measured, then asked again if it came up short.
   *
   * This is the part that was missing. Telling a model a word count and never
   * checking it is how a 60-second reel arrives as 30 seconds — one retry
   * naming the shortfall and the sections to grow costs a second call on the
   * drafts that need it and nothing on the ones that don't.
   */
  if (script.short) {
    const thin = script.segments
      .filter((s) => s.words < s.targetWords)
      .map((s) => `${s.label} (${s.words} words, needs ${s.targetWords})`)
      .join("; ");

    const second = await generate(
      b,
      system,
      ask(
        `\nYour previous draft was ${script.totalWords} words and needs at least ${floor}. ` +
          `Short sections: ${thin}. Rewrite the whole script longer — add real content to the body: ` +
          `${kind.shape} Do not pad, do not repeat, do not stretch the hook, do not add a second ask.`
      )
    );
    if (second) {
      const grown = build(second);
      // Keep whichever is closer to the length asked for. A retry that comes
      // back shorter than the first draft must not replace it.
      if (grown.totalWords > script.totalWords) script = grown;
    }
  }

  return script;
}

/** Fill in each section's word count, and say whether the whole thing is short. */
function measure(s: Script, plan: ReturnType<typeof scriptPlan>, floor: number): Script {
  s.segments = plan.map((p) => ({ ...p, words: countWords(s[p.key]) }));
  s.totalWords = s.segments.reduce((t, x) => t + x.words, 0);
  s.short = s.totalWords < floor;
  return s;
}

/**
 * Rewrite one part, leaving the rest alone.
 *
 * Asked for because regenerating the whole script to fix an opening throws
 * away four sections somebody already approved. The existing script goes into
 * the prompt so the replacement fits what surrounds it.
 */
export async function regenerateSection(
  clientId: number,
  input: ScriptInput,
  current: Script,
  section: ScriptSection
): Promise<string | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const language = (input.language ?? "English") as ScriptLanguage;
  const kind = contentType(input.type);
  const slot = scriptPlan(input.seconds ?? 40, kind.key).find((p) => p.key === section);
  const data = await generate(
    b,
    [
      "You are rewriting one section of a short-video script that is otherwise finished.",
      LANGUAGE_RULE[language] ?? LANGUAGE_RULE.English,
      `It is a ${kind.label.toLowerCase()} — ${kind.what} ${kind.shape}`,
      // Rewriting the ending is exactly where the four-ask habit creeps back in.
      section === "cta"
        ? kind.ask === "direct"
          ? "The ending asks for the client's own action only — no save, share, comment or follow."
          : `The ending asks for one thing: a ${kind.ask}, with its reason. Not two, not four.`
        : "",
      "Return only the replacement for that section. It must fit what comes before and after it.",
      "Length is a requirement: reach the words asked for. Over is fine, under is not.",
      "Reply with JSON only.",
    ]
      .filter(Boolean)
      .join(" "),
    [
      `Topic: ${input.topic}`,
      "",
      "The script as it stands:",
      `HOOK: ${current.hook}`,
      `BODY: ${current.body}`,
      `CTA: ${current.cta}`,
      "",
      `Rewrite only the ${section.toUpperCase()}. Different from the current one, same job.`,
      // The rewritten part has to fill the same slot on the clock, or fixing an
      // opening quietly shortens the video.
      slot
        ? `It owns seconds ${slot.from}–${slot.to} of a ${input.seconds ?? 40}-second script, so write at least ${slot.targetWords} words. Longer is fine; shorter is not.`
        : "",
      "",
      'Reply as JSON: {"text": "the replacement"}',
    ].join("\n")
  );
  const text = asStr(data?.text);
  return text || null;
}

/** Keep a script in the library — the `scripts` table has been there all along. */
export async function saveScript(input: {
  clientId: number;
  deliverableId?: number | null;
  title: string;
  body: string;
  platform?: string | null;
  createdBy?: number | null;
}): Promise<number> {
  if (!(await hasTable("scripts"))) return 0;
  const res = await execute(
    `INSERT INTO scripts (client_id, deliverable_id, title, body, platform, month_key, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.clientId,
      input.deliverableId ?? null,
      input.title.slice(0, 255),
      input.body,
      input.platform?.slice(0, 40) ?? null,
      thisMonthKey(),
      input.createdBy ?? null,
    ]
  );
  return Number(res.insertId) || 0;
}

/* ----------------------------- 4. Thumbnails ----------------------------- */

/**
 * Thumbnail concepts, described so a designer can build them.
 *
 * Text, not images. The portal has no image model wired in, and a description
 * a designer can execute is worth more here than a generated picture nobody
 * would ship — the brand colours from the knowledge base are in every concept,
 * which is the part that makes them usable.
 */
export async function thumbnailConcepts(
  clientId: number,
  input: { topic: string; platform?: string; count?: number }
): Promise<ThumbnailConcept[] | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const n = Math.min(6, Math.max(1, input.count ?? 3));
  const data = await generate(
    b,
    [
      "You design thumbnail concepts for a digital-marketing agency.",
      "A concept must be executable by a designer: say what is on it, where, and in what colours.",
      "Use the client's brand colours from the brief where they are given.",
      "Thumbnail text is 3-5 words. Longer is unreadable at the size it is seen.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `${n} thumbnail concepts for ${b.client}, for a ${input.platform || "Instagram Reel"} about: ${input.topic}`,
      "",
      "Reply as JSON:",
      '{ "concepts": [{',
      '  "title": "the 3-5 words on the thumbnail",',
      '  "hook": "the promise it makes to someone scrolling",',
      '  "expression": "what the person on it is doing or feeling",',
      '  "layout": "where everything sits",',
      '  "elements": ["supporting visual elements"],',
      '  "colors": "the palette, using their brand colours",',
      '  "aspect": "9:16 | 1:1 | 16:9"',
      "}] }",
    ].join("\n")
  );
  if (!data || !Array.isArray(data.concepts)) return null;

  return (data.concepts as Record<string, unknown>[]).map((c) => ({
    title: asStr(c.title),
    hook: asStr(c.hook),
    expression: asStr(c.expression),
    layout: asStr(c.layout),
    elements: asList(c.elements),
    colors: asStr(c.colors),
    aspect: asStr(c.aspect) || "9:16",
  }));
}

/* -------------------------------- 5. SEO -------------------------------- */

/**
 * Keywords, titles and clusters — local ones separately.
 *
 * Local is the whole game for the businesses this agency serves. "Best
 * physiotherapist in Vijayawada" is the search that produces a phone call and
 * "physiotherapy exercises" is the one that produces nothing, so the two are
 * asked for and shown apart rather than mixed into one list.
 */
export async function seoPack(
  clientId: number,
  input: { topic: string; city?: string | null }
): Promise<SeoPack | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const data = await generate(
    b,
    [
      "You do SEO for local businesses.",
      "Local intent is the priority: the searches that end in a phone call, not the ones that end in reading.",
      "Never invent a location. Use the city in the brief, or leave the local list empty.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `SEO for ${b.client}${input.city ? ` in ${input.city}` : ""}, on the subject: ${input.topic}`,
      "",
      "Reply as JSON:",
      "{",
      '  "keywords": ["8-12 general keywords"],',
      '  "local_keywords": ["6-10 with the city or area in them"],',
      '  "titles": ["5 page or video titles under 60 characters"],',
      '  "meta_descriptions": ["3, each under 155 characters"],',
      '  "youtube_keywords": ["8-12 for YouTube specifically"],',
      '  "clusters": [{"name":"the theme","topics":["blog or video topics under it"]}]',
      "}",
    ].join("\n")
  );
  if (!data) return null;

  return {
    keywords: asList(data.keywords),
    localKeywords: asList(data.local_keywords),
    titles: asList(data.titles),
    metaDescriptions: asList(data.meta_descriptions),
    youtubeKeywords: asList(data.youtube_keywords),
    clusters: Array.isArray(data.clusters)
      ? (data.clusters as Record<string, unknown>[]).map((c) => ({
          name: asStr(c.name),
          topics: asList(c.topics),
        }))
      : [],
  };
}

/* -------------------------- Idea → task on the board -------------------------- */

/**
 * Turn an idea into real work.
 *
 * The loop the whole system is for: performance produces an idea, the idea
 * becomes a task, the task becomes a post, the post produces performance. An
 * ideas panel with no way out of it is a list somebody copies by hand into the
 * board, which is where good ideas stop.
 */
export async function ideaToTask(input: {
  clientId: number;
  idea: Idea;
  dueDate?: string | null;
  createdBy: number;
  assignedTo?: number | null;
}): Promise<number> {
  const category = /carousel/i.test(input.idea.format)
    ? "Instagram Post"
    : /post|photo|image/i.test(input.idea.format)
      ? "Instagram Post"
      : "Instagram Reel";

  const res = await execute(
    `INSERT INTO deliverables
       (client_id, title, description, content_hook, platform, service, content_category,
        content_type, video_type, target_audience, due_date, priority, status, month_key,
        created_by, assigned_to)
     VALUES (?,?,?,?,'instagram','video_editing',?,?,?,?,?,'medium','pending',?,?,?)`,
    [
      input.clientId,
      input.idea.topic.slice(0, 255),
      // The reason travels with the task. Whoever picks it up in a fortnight
      // needs to know why it was chosen, and the CTA is part of the brief.
      [input.idea.why, input.idea.cta ? `CTA: ${input.idea.cta}` : null]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2000),
      input.idea.hook.slice(0, 1000),
      category,
      /*
       * The decision, written down.
       *
       * This one column is what closes the loop: when this post has results,
       * `learning.ts` reads them back by this key and the next brief is
       * written knowing whether a myths reel was worth making. Without it the
       * task says "Instagram Reel" — which is a taxonomy, not a decision.
       */
      contentType(input.idea.type).key,
      category,
      input.idea.audience.slice(0, 255),
      input.dueDate || null,
      input.dueDate ? input.dueDate.slice(0, 7) : thisMonthKey(),
      input.createdBy,
      input.assignedTo ?? null,
    ]
  );
  return Number(res.insertId) || 0;
}

/** The client's city, for the SEO panel's default. */
export async function cityOf(clientId: number): Promise<string | null> {
  const r = await queryOne<{ placeholder_values: unknown }>(
    "SELECT placeholder_values FROM clients WHERE id = ?",
    [clientId]
  ).catch(() => null);
  const ph = r?.placeholder_values;
  const obj = ph && typeof ph === "object" ? (ph as Record<string, unknown>) : {};
  const city = obj.location ?? obj.city;
  return city ? String(city).trim() || null : null;
}

/* ------------------------- 6. Poster content ------------------------- */

export type PosterContent = {
  /** The big line on the poster. Short — it is read at arm's length. */
  headline: string;
  /** One or two supporting lines. */
  subtext: string;
  /** Which of the client's own calls to action goes on it. */
  cta: string;
  /** What the designer should actually draw. */
  visual: string;
  /** Anything else that must appear — logo, phone, offer. */
  elements: string[];
};

/**
 * The words that go on a poster, for the designer to lay out.
 *
 * The gap this closes is small and expensive: a poster task used to reach a
 * designer as a title and a due date, so either they invented the copy or the
 * task sat until somebody wrote it. Neither is design work.
 *
 * Short by construction. A poster is read across a room, and a model asked
 * for "poster copy" will happily return a paragraph — so the length limits
 * are in the instruction and the brand rules are in the prompt, which is what
 * keeps a headline from claiming something the client will not say.
 */
export async function posterContent(
  clientId: number,
  input: { topic: string; occasion?: string | null; kind?: string | null }
): Promise<PosterContent | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  // Same rule as a reel: the kind is chosen first and it decides the shape.
  // An offer poster and a festival greeting are not the same poster with
  // different words in it.
  const kind = posterKind(input.kind);

  const data = await generate(
    b,
    [
      "You write the copy that goes on a printed or social poster for a business.",
      "A poster is read at a glance: the headline is at most 8 words, the supporting text at most 20.",
      `THIS ONE IS A ${kind.label.toUpperCase()} — ${kind.what} ${kind.shape}`,
      `What it asks of somebody who stops: ${kind.ask}`,
      "Write in the language and tone the brief describes.",
      "The call to action must be one the client already uses.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `Poster for ${b.client}. Subject: ${input.topic}`,
      `Kind: ${kind.label} — ${kind.what}`,
      input.occasion ? `Occasion: ${input.occasion}` : "",
      "",
      "Reply as JSON:",
      "{",
      '  "headline": "the big line, max 8 words",',
      '  "subtext": "one or two supporting lines, max 20 words",',
      '  "cta": "the call to action",',
      '  "visual": "what the designer should draw or photograph",',
      '  "elements": ["anything else that must appear on it"]',
      "}",
    ]
      .filter(Boolean)
      .join("\n")
  );
  if (!data) return null;

  const out: PosterContent = {
    headline: asStr(data.headline),
    subtext: asStr(data.subtext),
    cta: asStr(data.cta),
    visual: asStr(data.visual),
    elements: asList(data.elements),
  };
  return out.headline || out.subtext ? out : null;
}

/**
 * What posters to make, before what goes on them.
 *
 * The same tool the video side has had all along, and posters needed it more:
 * a month of posters is where an agency repeats itself fastest, because
 * "festival poster" writes itself and nothing else gets suggested. Each idea
 * names its kind, so the one that becomes a task carries it — and the loop
 * measures which kinds this client's audience actually stops for.
 */
export async function posterIdeas(clientId: number, count = 8): Promise<PosterIdea[] | null> {
  const b = await buildBrief(clientId);
  if (!b) return null;

  const n = Math.min(15, Math.max(3, count));
  const data = await generate(
    b,
    [
      "You plan the posters a local business puts out.",
      "A poster is read across a room in about a second — every idea has to survive that.",
      "Every idea must be specific to this business. Never one that would fit any shop.",
      "Spread the kinds: a month of nothing but offers reads as a business in trouble.",
      "Reply with JSON only.",
    ].join(" "),
    [
      `Give ${n} poster ideas for ${b.client}.`,
      "",
      "Every idea names its kind, exactly one of these keys:",
      POSTER_KINDS.map((k) => `  ${k.key} — ${k.label}: ${k.what}`).join("\n"),
      "",
      "Reply as JSON:",
      '{ "ideas": [{',
      '  "topic": "what this poster is about, in a few words",',
      '  "kind": "one of the keys above",',
      '  "headline": "the big line as it would appear, at most 8 words",',
      '  "visual": "what the designer draws or photographs",',
      '  "occasion": "the date or event it hangs on, or empty",',
      '  "why": "the reason for this one, citing the brief above"',
      "}] }",
    ].join("\n")
  );
  if (!data || !Array.isArray(data.ideas)) return null;

  return (data.ideas as Record<string, unknown>[]).map((i) => {
    // Resolved to a known key rather than stored raw: an unrecognised kind
    // would be recorded and then ignored by every read, which looks exactly
    // like a kind that never performs.
    const kind = posterKind(asStr(i.kind));
    return {
      topic: asStr(i.topic),
      kind: kind.key,
      kindLabel: kind.label,
      headline: asStr(i.headline),
      visual: asStr(i.visual),
      occasion: asStr(i.occasion),
      why: asStr(i.why),
    };
  });
}

/**
 * A poster idea, onto the board, with its kind and its copy on it.
 *
 * The poster equivalent of `ideaToTask`, and the same reasoning: a list of
 * ideas with no way out of it is a list somebody retypes into the board, which
 * is where good ideas stop. It lands as an ordinary poster task in the
 * designer's service, so the existing hand-off — brief, design, approval —
 * picks it up unchanged.
 */
export async function posterToTask(input: {
  clientId: number;
  idea: PosterIdea;
  brief?: string | null;
  dueDate?: string | null;
  createdBy: number;
  assignedTo?: number | null;
}): Promise<number> {
  const res = await execute(
    `INSERT INTO deliverables
       (client_id, title, description, platform, service, content_category, content_type,
        video_type, due_date, priority, status, month_key, created_by, assigned_to)
     VALUES (?,?,?,'instagram','poster_designing','Poster',?,'Poster',?,'medium','pending',?,?,?)`,
    [
      input.clientId,
      input.idea.topic.slice(0, 255),
      // The brief travels with the task: a poster that reaches a designer as a
      // title and a due date is a poster they have to invent the copy for.
      [
        input.brief?.trim() || null,
        input.idea.visual ? `VISUAL: ${input.idea.visual}` : null,
        input.idea.why ? `WHY: ${input.idea.why}` : null,
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2000),
      posterKind(input.idea.kind).key,
      input.dueDate || null,
      input.dueDate ? input.dueDate.slice(0, 7) : thisMonthKey(),
      input.createdBy,
      input.assignedTo ?? null,
    ]
  );
  return Number(res.insertId) || 0;
}

/** The poster content as the brief a designer reads on their card. */
export function renderPosterBrief(p: PosterContent): string {
  return [
    `HEADLINE: ${p.headline}`,
    p.subtext ? `TEXT: ${p.subtext}` : null,
    p.cta ? `CALL TO ACTION: ${p.cta}` : null,
    p.visual ? `VISUAL: ${p.visual}` : null,
    p.elements.length ? `ALSO ON IT: ${p.elements.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
