/**
 * The shapes the content studio passes around.
 *
 * Its own module because the studio is a client component and `content-ai.ts`
 * is `server-only` — importing it for a type would drag the database driver
 * into the browser bundle and fail the build. Same split `lead-stages.ts` has
 * from `leads.ts` and `expense-kinds.ts` from `expenses.ts`.
 *
 * Types and one constant. No database, no model, no request.
 */

export const SCRIPT_LANGUAGES = ["English", "Telugu", "Tenglish"] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

export type Strategy = {
  month: string;
  summary: string;
  pillars: { name: string; share: string; why: string }[];
  frequency: string;
  formats: string[];
  postingPlan: string[];
  /** False when there was not enough published history to ground the advice. */
  grounded: boolean;
};

export type Idea = {
  topic: string;
  hook: string;
  /**
   * Which of the nine formats this is — the thing the loop records against the
   * task and measures the result by. Without it an idea becomes "a reel", and
   * a reel is not a decision anybody can learn from.
   */
  type: ContentTypeKey;
  typeLabel: string;
  format: string;
  audience: string;
  cta: string;
  /** Why this one, in terms of the client's own numbers. The point of the tool. */
  why: string;
  /** high | medium | low — the model's estimate, labelled as one. */
  potential: string;
};

export type ScriptInput = {
  topic: string;
  platform?: string;
  seconds?: number;
  language?: ScriptLanguage;
  tone?: string;
  audience?: string;
  objective?: string;
  /** Which kind of content this is. Decides the shape, the clock and the ask. */
  type?: ContentTypeKey;
};

/**
 * Three sections, not five.
 *
 * An intro and a worked example were two more places for a short reel to lose
 * its viewer — on a 30-second cut the intro is the hook repeated and the
 * example is the body again. The body now carries the substance, including
 * whatever example belongs in it, and the seconds they used to hold go to the
 * two parts that do the work: getting somebody to stay, and getting them to
 * act.
 */
export type Script = {
  hook: string;
  body: string;
  cta: string;
  /** The whole thing, as it would be read aloud. */
  full: string;
  /** Other openings, so a hook can be swapped without regenerating. */
  altHooks: string[];
  /** The clock: which seconds each section owns, and how long it came back. */
  segments: ScriptSegment[];
  /** Total words in the script, and what the requested length needs. */
  totalWords: number;
  targetWords: number;
  /** True when the draft came back short of the length that was asked for. */
  short: boolean;
};

export type ScriptSection = "hook" | "body" | "cta";

/**
 * The four things a viewer can be asked for, and the vocabulary the CTA draws
 * from. A script asks for exactly ONE of them — see `ContentType.ask`.
 */
export const ENGAGEMENT_ASKS = ["save", "share", "comment", "follow"] as const;
export type EngagementAsk = (typeof ENGAGEMENT_ASKS)[number];

export type ContentTypeKey =
  | "education"
  | "ad"
  | "lead_magnet"
  | "graphic"
  | "rating"
  | "clone"
  | "funny"
  | "rapid_fire"
  | "myths";

/**
 * One kind of content, and everything that follows from being that kind.
 *
 * A rating video and an ad are not the same thing written on different
 * subjects — they are built differently, they run at a different speed, and
 * they end by asking for different things. Writing them all as "a reel" is
 * what produces the content that is technically fine and does nothing.
 *
 * So the format is chosen first and it decides three things: how the body is
 * built (`shape`), how much of the clock the ending owns (`ctaShare`), and the
 * one thing the ending asks for (`ask`).
 */
export type ContentType = {
  key: ContentTypeKey;
  label: string;
  /** What this format is, in one line. Shown under the picker and given to the model. */
  what: string;
  /** How the body of this one is built. The part that stops every script reading alike. */
  shape: string;
  /**
   * The single ask this format has earned. `direct` means the client's own
   * action — call, DM, book — and no engagement ask at all.
   */
  ask: EngagementAsk | "direct";
  /** Why that one and not another, in the words the model is given. */
  askWhy: string;
  /** Share of the clock the ending owns. An ad closes; a joke does not. */
  ctaShare: number;
  /**
   * Words per second against a spoken script.
   *
   * On-screen text is read, not spoken, and it is read slower — holding a
   * graphic reel to a talking script's word count fills the cards with
   * sentences nobody can read before they cut.
   */
  pace: number;
  /** Grouped apart in the picker: these are formats borrowed from the feed. */
  trending?: boolean;
};

/**
 * The formats this agency actually makes. Order is the order in the picker,
 * and the first one is the default.
 */
export const CONTENT_TYPES: ContentType[] = [
  {
    key: "education",
    label: "Education reel",
    what: "Teaching one thing properly, start to finish.",
    shape:
      "One problem, why it happens, then the steps in order. Depth over breadth — one thing explained fully beats five mentioned.",
    ask: "save",
    askWhy: "They will need this again the day the problem happens, and a save is where they will look for it.",
    ctaShare: 0.15,
    pace: 1,
  },
  {
    key: "ad",
    label: "Ad video",
    what: "A paid promo with one offer and one action.",
    shape:
      "The problem in the first line, then the offer, then what it includes or costs, then why now. No teaching — this is not a free lesson with a price at the end.",
    ask: "direct",
    askWhy:
      "Every second is bought. A save or a follow spends it on something that is not the enquiry the client is paying for.",
    ctaShare: 0.22,
    pace: 1,
  },
  {
    key: "lead_magnet",
    label: "Lead magnet",
    what: "A free thing given in exchange for a comment or a DM.",
    shape:
      "Name what they get in the first line, prove in the body that it is worth having — show one piece of it — then say the exact word to send.",
    ask: "comment",
    askWhy: "The whole video exists to produce that one comment, which is what starts the conversation.",
    ctaShare: 0.22,
    pace: 1,
  },
  {
    key: "graphic",
    label: "Graphic reel",
    what: "Text on screen, no talking head.",
    shape:
      "Written as numbered on-screen cards, one short line each — the words ARE the visual, so nothing that needs saying out loud to make sense. Six to ten cards.",
    ask: "save",
    askWhy: "A card somebody wants to read twice is a card they save.",
    ctaShare: 0.15,
    pace: 0.6,
  },
  {
    key: "rating",
    label: "Rating / ranking",
    what: "Scoring or ranking things, and the viewer disagreeing.",
    shape:
      "Item, score, one line of verdict, next. Move fast. Leave one score deliberately arguable — that is the video's engine.",
    ask: "comment",
    askWhy: "The argument is the point: somebody who disagrees with a score will say so without being persuaded.",
    ctaShare: 0.15,
    pace: 1,
    trending: true,
  },
  {
    key: "clone",
    label: "Trend clone",
    what: "A format that is working right now, with this client's subject inside it.",
    shape:
      "Keep the trend's beats exactly as people know them and swap only the subject. Name the format in the hook so it is recognised in the first second.",
    ask: "share",
    askWhy: "A recognised format gets sent on because sending it is part of the joke.",
    ctaShare: 0.12,
    pace: 1,
    trending: true,
  },
  {
    key: "funny",
    label: "Funny / relatable",
    what: "A joke or a moment people recognise. No lesson.",
    shape:
      "Setup, turn, punchline. Nothing is explained after the punchline — the explanation is what kills it.",
    ask: "share",
    askWhy: "Nobody saves a joke. They send it to the one person it is about.",
    ctaShare: 0.1,
    pace: 1,
    trending: true,
  },
  {
    key: "rapid_fire",
    label: "Rapid fire",
    what: "Many short questions answered fast.",
    shape:
      "Question, answer, next. Eight to twelve of them, no linking sentences, no wind-up. Answers of one line each.",
    ask: "follow",
    askWhy: "They stayed through the whole list, so the follow is earned here — offer them the next round.",
    ctaShare: 0.12,
    pace: 1,
    trending: true,
  },
  {
    key: "myths",
    label: "Myths vs facts",
    what: "Common beliefs, corrected one at a time.",
    shape:
      "The myth stated the way people actually say it, then the fact, then why the myth spread. Three or four pairs, no more.",
    ask: "share",
    askWhy: "Everybody watching knows somebody who believes one of these, and correcting them is the reason to send it.",
    ctaShare: 0.15,
    pace: 1,
    trending: true,
  },
];

/** The chosen format, or the default. Never throws on an unknown key. */
export const contentType = (key?: string | null): ContentType =>
  CONTENT_TYPES.find((t) => t.key === key) ?? CONTENT_TYPES[0];

/**
 * The kinds of poster this agency actually makes.
 *
 * A poster is not a short reel with fewer words. It is read across a room in
 * about a second, and what that second has to deliver depends entirely on why
 * the poster exists — an offer has to be legible at a glance and a festival
 * greeting has to feel like a greeting rather than an advert wearing one.
 *
 * Same job as `CONTENT_TYPES`: the kind is chosen first and it decides the
 * shape of the copy and what the poster asks for. And, like the reel formats,
 * it is recorded against the task so the loop can learn which kinds actually
 * earn anything.
 */
export type PosterKind = {
  key: string;
  label: string;
  /** What this kind is, in one line. Shown in the picker, given to the model. */
  what: string;
  /** What the copy has to do. The part that stops every poster reading alike. */
  shape: string;
  /** What it asks of somebody who stops. */
  ask: string;
};

export const POSTER_KINDS: PosterKind[] = [
  {
    key: "offer",
    label: "Offer / discount",
    what: "A price, a saving or a limited deal.",
    shape:
      "The offer IS the headline — the number goes in it, not in the small print. Then what is included, then when it ends. Never bury the price.",
    ask: "Call or message to book it, with the deadline said plainly.",
  },
  {
    key: "festival",
    label: "Festival greeting",
    what: "A greeting on a festival or a national day.",
    shape:
      "The greeting first and the business second. No offer, no service list — a greeting that sells is the one people scroll past.",
    ask: "Nothing. The client's name and logo are the whole of the ask.",
  },
  {
    key: "testimonial",
    label: "Client testimonial",
    what: "A real customer, in their own words.",
    shape:
      "The quote is the headline, cut to its strongest sentence. Then who said it and what they came for. Nothing the business says about itself.",
    ask: "Come and see for yourself — soft, because the proof has done the work.",
  },
  {
    key: "tip",
    label: "Tip / awareness",
    what: "One useful thing, given away.",
    shape:
      "One tip, not five. Say the thing people get wrong, then what to do instead, in the fewest words that still teach it.",
    ask: "Save it, and ask us if you want the rest.",
  },
  {
    key: "announcement",
    label: "Announcement",
    what: "Something new: a service, a branch, new timings.",
    shape:
      "What changed, from when, and where. A date and an address are the two things people photograph this for.",
    ask: "The address and the phone number, large enough to read from a photo.",
  },
  {
    key: "hiring",
    label: "We're hiring",
    what: "An open role at the client's business.",
    shape:
      "The role and the place in the headline. Then what is needed and what is offered — a hiring poster with no pay range or no location gets shared and never answered.",
    ask: "Where to send it, and by when.",
  },
  {
    key: "before_after",
    label: "Before and after",
    what: "A result, shown as a change.",
    shape:
      "Two states and the gap between them. The words only label what the picture already shows — how long it took, and what it took.",
    ask: "Book the same thing, named as the thing in the picture.",
  },
  {
    key: "price_list",
    label: "Price list / menu",
    what: "What things cost, laid out.",
    shape:
      "Items and prices in one column, most-wanted first, at most eight lines. A price list somebody has to zoom into is a price list nobody read.",
    ask: "How to order, once, at the bottom.",
  },
];

export const posterKind = (key?: string | null): PosterKind =>
  POSTER_KINDS.find((k) => k.key === key) ?? POSTER_KINDS[0];

/**
 * Every format key the portal records against a task, reel and poster alike.
 *
 * The loop reads results back by this key, and it is the guard on a column
 * that predates all of it — see `learning.ts`.
 */
export const ALL_FORMAT_KEYS: string[] = [
  ...CONTENT_TYPES.map((t) => t.key),
  ...POSTER_KINDS.map((k) => k.key),
];

/** The human name for any recorded format key, whichever list it came from. */
export function formatLabelFor(key: string): string {
  return (
    CONTENT_TYPES.find((t) => t.key === key)?.label ??
    POSTER_KINDS.find((k) => k.key === key)?.label ??
    key
  );
}

export type ThumbnailConcept = {
  title: string;
  hook: string;
  expression: string;
  layout: string;
  elements: string[];
  colors: string;
  aspect: string;
};

export type SeoPack = {
  keywords: string[];
  localKeywords: string[];
  titles: string[];
  metaDescriptions: string[];
  youtubeKeywords: string[];
  clusters: { name: string; topics: string[] }[];
};

/**
 * One timed part of a script.
 *
 * A reel is not five paragraphs, it is a clock — the hook has three seconds
 * and the body has thirty, and a script that ignores that is a script the
 * editor cuts down on the timeline. So every section carries the seconds it
 * owns and the words that fit in them.
 */
export type ScriptSegment = {
  key: ScriptSection;
  label: string;
  /** Seconds from the start of the video. */
  from: number;
  to: number;
  /** Words that fit in that time at a natural speaking pace. */
  targetWords: number;
  /** What the draft actually came back with. */
  words: number;
};

/** Words a person speaks in a second, at a natural pace. */
export const WORDS_PER_SECOND = 2.5;

/**
 * How a script of N seconds divides up.
 *
 * The hook gets a hard floor of three seconds because that is the whole of
 * its job — below that there is no hook, there is a first word. Everything
 * else scales, and the body takes the largest share because that is the part
 * a viewer stays for.
 *
 * Pure and exported so the test can check the arithmetic and the panel can
 * show the clock without asking the server.
 */
export function scriptPlan(seconds: number, type?: string | null): Omit<ScriptSegment, "words">[] {
  const t = contentType(type);
  const total = Math.min(180, Math.max(10, Math.round(seconds)));

  /*
   * The two ends get floors; the body takes what is left.
   *
   * Taking a percentage of each in order and giving the remainder to the last
   * one put the CTA on one second at fifteen seconds — too short to ask for a
   * save, let alone a comment. So the hook and the CTA are sized first, each
   * with a minimum that keeps them able to do their job, and the body absorbs
   * the rest. It is the longest section at every length, which is right: it is
   * the only part somebody stays for.
   */
  const hook = Math.max(3, Math.round(total * 0.1));
  // How long the ending gets is the format's decision: an ad closes and needs
  // the room to, a joke ends on the punchline and a tacked-on ask ruins it.
  const cta = Math.max(4, Math.round(total * t.ctaShare));
  const body = Math.max(3, total - hook - cta);

  const spans: { key: ScriptSection; label: string; span: number }[] = [
    { key: "hook", label: "Hook", span: hook },
    { key: "body", label: "Body", span: body },
    { key: "cta", label: "Call to action", span: cta },
  ];

  const out: Omit<ScriptSegment, "words">[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    // The last section runs to the end, so the parts always add up to the
    // length asked for rather than to 59 or 61 after rounding.
    const to = i === spans.length - 1 ? at + s.span : Math.min(total, at + s.span);
    out.push({
      key: s.key,
      label: s.label,
      from: at,
      to,
      targetWords: Math.max(4, Math.round((to - at) * WORDS_PER_SECOND * t.pace)),
    });
    at = to;
  });
  return out;
}

/** Words in a line of script — whitespace-separated, which holds for Telugu too. */
export const countWords = (s: string): number =>
  String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * The floor a script has to clear.
 *
 * Eighty-five per cent of the target, because a 60-second ask that comes back
 * as 40 seconds of speech is the complaint this exists to answer — over is
 * fine, an editor can trim, and under means reshooting or padding on the day.
 */
export const wordFloor = (seconds: number, type?: string | null): number =>
  Math.round(seconds * WORDS_PER_SECOND * contentType(type).pace * 0.85);
