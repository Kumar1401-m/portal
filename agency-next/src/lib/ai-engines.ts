/**
 * The AI engines, as a list the agency can switch on and off.
 *
 * Every AI feature in the portal registers here rather than reading its own
 * flag from its own corner. That is what makes them independently
 * upgradeable: a caption generator that stops behaving can be turned off
 * without taking the ads analyst down with it, and a new engine is a row in
 * this list plus its own module — never an edit to the ones already working.
 *
 * Three things gate an engine, and they are deliberately different questions:
 *
 *   `configured` — is there a model key at all? Nothing runs without one.
 *   `enabled`    — has the agency switched it on? Stored, defaults on.
 *   `ready`      — does this install have the data the engine needs? An ads
 *                  analyst with no ad account is not broken, it is unfed, and
 *                  saying so is the difference between a bug report and a
 *                  setup step.
 *
 * Pure except for the two lookups at the bottom, so the catalogue can be read
 * anywhere — including by a client component listing what is available.
 */
import "server-only";
import { env } from "./env";
import { query, execute } from "./db";

export type EngineKey =
  | "brain"
  | "insights"
  | "strategist"
  | "scripts"
  | "captions"
  | "video_analyzer"
  | "performance"
  | "ideas"
  | "posting_time"
  | "ads_analyst"
  | "lead_scoring"
  | "client_health"
  | "reports"
  | "approval_assistant"
  | "task_assignment"
  | "deadline"
  | "thumbnails"
  | "seo"
  | "sentiment"
  | "business_advisor"
  | "competitors"
  | "trends";

export type EngineState = "live" | "off" | "unconfigured" | "needs_data" | "planned";

export type Engine = {
  key: EngineKey;
  label: string;
  /** One line, in the words of someone who would use it. */
  purpose: string;
  /** Which module implements it, so the next person can find it. */
  module: string;
  /** What must exist in the database before it can say anything true. */
  needs: string[];
  /** False while an engine is specified but not yet built. */
  built: boolean;
};

/**
 * The catalogue.
 *
 * `built: false` is not a placeholder for a page that pretends to work — an
 * unbuilt engine is listed as planned and offers nothing. The list is honest
 * about what exists so nobody demos a feature that isn't there.
 */
export const ENGINES: Engine[] = [
  {
    key: "brain",
    label: "Marketing Brain",
    purpose: "Answers why a client's numbers moved, from their own data",
    module: "lib/brain.ts",
    needs: ["post_insights"],
    built: true,
  },
  {
    key: "insights",
    label: "Insights Center",
    purpose: "Finds what needs attention before anybody asks",
    module: "lib/ai-insights.ts",
    needs: ["ai_insights"],
    built: true,
  },
  {
    key: "captions",
    label: "Caption Generator",
    purpose: "Platform captions, hashtags, keywords and CTA from the client's own details",
    module: "lib/ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "video_analyzer",
    label: "Video Analyzer",
    purpose: "Watches the uploaded file and reports what it actually contains",
    module: "lib/video-ai.ts",
    needs: ["video_analysis"],
    built: true,
  },
  {
    key: "performance",
    label: "Performance Analyst",
    purpose: "What reached, what engaged, and which format did it",
    module: "lib/analytics.ts",
    needs: ["post_insights"],
    built: true,
  },
  {
    key: "posting_time",
    label: "Posting-Time Optimizer",
    purpose: "Best day and hour, from this client's own history",
    module: "lib/analytics.ts",
    needs: ["post_insights"],
    built: true,
  },
  {
    key: "reports",
    label: "Monthly Report",
    purpose: "The client's month, written up and ready to send",
    module: "lib/monthly-report.ts",
    needs: ["scheduled_reports"],
    built: true,
  },
  {
    key: "client_health",
    label: "Client Health Score",
    purpose: "Which clients need attention, and exactly why",
    module: "lib/brain.ts",
    needs: [],
    built: true,
  },
  {
    key: "ads_analyst",
    label: "Ads Analyst",
    purpose: "Rising cost per lead, falling CTR, and which creative caused it",
    module: "lib/brain.ts",
    needs: ["ad_insights"],
    built: true,
  },
  {
    key: "strategist",
    label: "Content Strategist",
    purpose: "The month's pillars, topics and posting plan",
    module: "lib/content-ai.ts",
    needs: ["post_insights"],
    built: true,
  },
  {
    key: "scripts",
    label: "Script Generator",
    purpose: "Hook, body and CTA in English, Telugu or Tenglish",
    module: "lib/content-ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "ideas",
    label: "Content Ideas",
    purpose: "New ideas from what already worked, each with its reason",
    module: "lib/content-ai.ts",
    needs: ["post_insights"],
    built: true,
  },
  {
    key: "lead_scoring",
    label: "Lead Scoring",
    purpose: "Hot, warm or cold, with every point explained",
    module: "lib/lead-score.ts",
    needs: ["leads"],
    built: true,
  },
  {
    key: "approval_assistant",
    label: "Approval Assistant",
    purpose: "Turns a client's feedback into a checklist somebody accepts",
    module: "lib/revision-tasks.ts",
    needs: ["feedback_items"],
    built: true,
  },
  {
    key: "task_assignment",
    label: "Task Assignment",
    purpose: "Who has the capacity and the track record",
    module: "lib/team-ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "deadline",
    label: "Deadline Prediction",
    purpose: "Which tasks will miss their date, and why",
    module: "lib/team-ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "thumbnails",
    label: "Thumbnail Assistant",
    purpose: "Title, expression and layout concepts in the brand colours",
    module: "lib/content-ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "seo",
    label: "SEO Assistant",
    purpose: "Local keywords, titles and content clusters",
    module: "lib/content-ai.ts",
    needs: [],
    built: true,
  },
  {
    key: "sentiment",
    label: "Sentiment Analyzer",
    purpose: "Which comments are questions, complaints, or somebody asking to buy",
    module: "lib/sentiment.ts",
    needs: ["post_comments"],
    built: true,
  },
  {
    key: "business_advisor",
    label: "Business Advisor",
    purpose: "Which clients earn, which cost, and who is about to leave",
    module: "lib/business-advisor.ts",
    needs: [],
    built: true,
  },
  {
    key: "competitors",
    label: "Competitor Analyzer",
    purpose: "The gap between this client and the rivals they name",
    module: "lib/competitors.ts",
    needs: ["competitors"],
    built: true,
  },
  {
    key: "trends",
    label: "Trend Detector",
    // Honest about what it is. The portal has no trending-topics feed, and
    // inventing one would undo the credibility of everything above it.
    purpose: "Subjects rivals are covering that this client is not — no trending feed exists to read",
    module: "lib/competitors.ts",
    needs: ["competitors"],
    built: true,
  },
];

export const engine = (key: EngineKey): Engine | undefined => ENGINES.find((e) => e.key === key);

/**
 * The settings row an engine's on/off switch is stored in.
 *
 * Its own rows in the shared `settings` table, read and written here rather
 * than through `lib/settings.ts`. That module's key list is mirrored
 * deliberately against the original Express portal so the two stay in sync,
 * and it silently drops any key it does not recognise — twenty-one engine
 * switches added to it would either break that mirror or, worse, appear to
 * save and vanish.
 */
export const switchKey = (key: EngineKey) => `ai_engine_${key}`;

/**
 * Is there a model behind any of this?
 *
 * One key for every engine. Two providers are supported and either will do —
 * `lib/ai.ts` already knows which to prefer, and this only asks whether one
 * of them exists at all.
 */
export const modelConfigured = () => env.openai.enabled || env.gemini.enabled;

/**
 * Whether an engine may run, and if not, which of the three reasons it is.
 *
 * `dataReady` is passed in rather than looked up, because the caller usually
 * knows already — a page that has just read a client's posts should not make
 * this function ask the database the same question again.
 */
export function stateOf(
  e: Engine,
  opts: { enabled: boolean; dataReady?: boolean } = { enabled: true }
): EngineState {
  if (!e.built) return "planned";
  if (!modelConfigured()) return "unconfigured";
  if (!opts.enabled) return "off";
  if (opts.dataReady === false) return "needs_data";
  return "live";
}

export const STATE_TEXT: Record<EngineState, string> = {
  live: "Running",
  off: "Switched off",
  unconfigured: "No model key",
  needs_data: "Waiting for data",
  planned: "Not built yet",
};

/**
 * Which engines the agency has switched off.
 *
 * Absent means on. A feature that has to be discovered and enabled before it
 * does anything is a feature nobody finds — the switch exists to turn
 * something off that is misbehaving, not to gate the first run.
 */
export async function disabledEngines(): Promise<Set<EngineKey>> {
  const off = new Set<EngineKey>();
  try {
    const rows = await query<{ setting_key: string; setting_value: string | null }>(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'ai\\_engine\\_%'"
    );
    const byKey = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
    for (const e of ENGINES) if (byKey.get(switchKey(e.key)) === "0") off.add(e.key);
  } catch {
    // A settings table that will not read means every engine stays on, which
    // is the same as a fresh install — never silently off.
  }
  return off;
}

export async function isEngineOn(key: EngineKey): Promise<boolean> {
  if (!modelConfigured()) return false;
  return !(await disabledEngines()).has(key);
}

export async function setEngine(key: EngineKey, on: boolean): Promise<void> {
  await execute(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?,?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [switchKey(key), on ? "1" : "0"]
  );
}
