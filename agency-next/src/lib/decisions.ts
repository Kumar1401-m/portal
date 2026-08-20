/**
 * The night shift: what the portal decided while nobody was looking.
 *
 * Everything needed to know what matters today was already here and none of it
 * ever came and found anybody. The Brain wrote findings to a page you had to
 * remember to open; overdue invoices sat on a board; a format that stopped
 * working was visible only if you went to look at the table. All of it waited
 * to be visited, which is another way of saying most of it was never read.
 *
 * So this runs once a night, gathers everything that might deserve attention,
 * decides which few actually do, and puts them in the notification bell with a
 * link to the thing to act on.
 *
 * ## What decides
 *
 * The ranking is arithmetic — severity, money at stake, days late, and how
 * much evidence is behind it. Not a model. A language model asked "what is
 * most important" will answer confidently and differently every night, and an
 * agency cannot plan against that. What the model does is the part it is
 * actually good at: reading the top few together and writing the sentence a
 * person would say about them. With no model key it writes that sentence
 * itself, and nothing else changes.
 *
 * ## Why so few
 *
 * Three a night, hard. A notification list is only read while it is short —
 * the failure mode here is not missing something, it is the bell that always
 * has forty things in it and therefore says nothing. Everything not sent is
 * still on its own board, where it always was.
 *
 * ## Why it does not repeat itself
 *
 * A decision is claimed by its title for a week. An invoice that is overdue on
 * Monday is still overdue on Tuesday, and being told again every morning is
 * how somebody learns to ignore the bell. That is also why the titles carry no
 * changing numbers — the amount goes in the body, so the same problem produces
 * the same title tomorrow and is recognised as already said.
 */
import "server-only";
import { query, queryOne, hasTable } from "./db";
import { onTheFloor } from "./client-status";
import { callJSON } from "./ai";
import { notifyAdmins } from "./notify";
import { learned, nextFormat } from "./learning";
import { thisMonthKey } from "./date-range";

/** How many reach the bell on one run. */
export const MAX_PER_RUN = 3;
/** How long a decision stays claimed, so the same news is not sent daily. */
const REPEAT_AFTER_DAYS = 7;

export type Decision = {
  /** What the notification says. Stable — no figures, so it can be claimed. */
  title: string;
  /** The figures and the reasoning. */
  body: string;
  /** Where to go and do something about it. */
  link: string;
  /** 0–100, computed here. What gets sent and in what order. */
  urgency: number;
  /** Which board it came from, for the icon and for reading the log. */
  source: "money" | "work" | "performance" | "content";
};

const num = (v: unknown) => Number(v ?? 0);
const money = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

/* ------------------------------ the candidates ------------------------------ */

/**
 * Money that should have arrived and has not.
 *
 * First because it is the only one of these that is unambiguous: an invoice
 * past its due date is a fact, not an interpretation, and it is the thing an
 * agency owner most wants a machine to remember on their behalf.
 */
async function overdueMoney(): Promise<Decision[]> {
  const rows = await query<{
    id: number;
    invoice_no: string;
    total: unknown;
    days: unknown;
    company_name: string;
  }>(
    `SELECT i.id, i.invoice_no, i.total, c.company_name,
            DATEDIFF(CURDATE(), i.due_date) AS days
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.status <> 'paid' AND i.due_date IS NOT NULL AND i.due_date < CURDATE()
      ORDER BY i.due_date ASC LIMIT 10`
  ).catch(() => []);

  return rows.map((r) => {
    const days = num(r.days);
    const total = num(r.total);
    return {
      title: `Invoice ${r.invoice_no} is overdue`,
      body:
        `${r.company_name} — ${money(total)}, ${days} day${days === 1 ? "" : "s"} past due. ` +
        `Chasing it from the payments board sends the invoice and the payment link together.`,
      link: "/payments",
      // A fortnight late matters more than a day late, and a large invoice
      // more than a small one — but neither runs away with the ranking.
      urgency: Math.min(95, 45 + Math.min(30, days) + Math.min(20, total / 5000)),
      source: "money" as const,
    };
  });
}

/**
 * Work that has run out of time.
 *
 * Grouped into one decision rather than one per task: eleven overdue tasks is
 * a single fact about the week, and eleven notifications about it is the bell
 * nobody reads again.
 */
async function lateWork(): Promise<Decision[]> {
  const row = await queryOne<{ n: unknown; worst: unknown }>(
    `SELECT COUNT(*) AS n, MAX(DATEDIFF(CURDATE(), d.due_date)) AS worst
       FROM deliverables d JOIN clients c ON c.id = d.client_id AND ${onTheFloor()}
      WHERE d.due_date < CURDATE()
        AND d.status NOT IN ('approved','scheduled','posted','completed','cancelled','rejected')`
  ).catch(() => null);

  const n = num(row?.n);
  if (n === 0) return [];
  const worst = num(row?.worst);
  return [
    {
      title: "Work is past its due date",
      body:
        `${n} task${n === 1 ? " is" : "s are"} overdue, the oldest by ${worst} day${worst === 1 ? "" : "s"}. ` +
        `They are on the board with the dates that passed.`,
      link: "/deliverables?today=1",
      urgency: Math.min(90, 35 + n * 4 + Math.min(25, worst)),
      source: "work" as const,
    },
  ];
}

/**
 * A client with nothing planned.
 *
 * The quietest failure the agency has: nobody notices an empty month until it
 * is over, and by then the month is what the client is paying for and did not
 * get.
 */
async function emptyMonths(): Promise<Decision[]> {
  const month = thisMonthKey();
  const rows = await query<{ id: number; company_name: string; monthly_deliverables: unknown }>(
    `SELECT c.id, c.company_name, c.monthly_deliverables
       FROM clients c
      WHERE ${onTheFloor()} AND COALESCE(c.is_personal,0) = 0
        AND COALESCE(c.monthly_deliverables,0) > 0
        AND NOT EXISTS (SELECT 1 FROM deliverables d WHERE d.client_id = c.id AND d.month_key = ?)
      ORDER BY c.monthly_deliverables DESC LIMIT 5`,
    [month]
  ).catch(() => []);

  return rows.map((r) => ({
    title: `Nothing planned for ${r.company_name} this month`,
    body:
      `They are down for ${num(r.monthly_deliverables)} pieces and the board is empty. ` +
      `The content studio can plan the month from what has worked for them before.`,
    link: `/studio?client=${r.id}`,
    urgency: 70,
    source: "content" as const,
  }));
}

/**
 * What the Brain found, if it has run.
 *
 * Only what is both serious and well-evidenced: a warning at 50% confidence is
 * a guess, and a guess in the notification bell costs more than it is worth.
 */
async function brainFindings(): Promise<Decision[]> {
  if (!(await hasTable("ai_insights"))) return [];

  const rows = await query<{
    client_id: number;
    company_name: string;
    kind: string;
    headline: string;
    detail: string | null;
    confidence: unknown;
    evidence_json: unknown;
  }>(
    `SELECT a.client_id, c.company_name, a.kind, a.headline, a.detail, a.confidence, a.evidence_json
       FROM ai_insights a JOIN clients c ON c.id = a.client_id
      WHERE a.confidence >= 60
      ORDER BY a.confidence DESC LIMIT 20`
  ).catch(() => []);

  const out: Decision[] = [];
  for (const r of rows) {
    let severity = "warning";
    let recommendation = "";
    try {
      const j = typeof r.evidence_json === "string" ? JSON.parse(r.evidence_json) : r.evidence_json;
      severity = String((j as Record<string, unknown>)?.severity ?? "warning");
      recommendation = String((j as Record<string, unknown>)?.recommendation ?? "");
    } catch {
      /* a finding with unreadable evidence is still a finding */
    }
    // Good news is not a notification. It is on the insights board for whoever
    // wants it, and the bell is for things that need doing.
    if (severity !== "critical" && severity !== "warning") continue;

    out.push({
      title: `${r.company_name}: ${r.headline}`.slice(0, 180),
      body: [r.detail, recommendation].filter(Boolean).join(" ").slice(0, 900),
      link: `/ai?client=${r.client_id}`,
      urgency: Math.min(92, (severity === "critical" ? 55 : 40) + num(r.confidence) * 0.4),
      source: "performance" as const,
    });
  }
  return out;
}

/**
 * What the loop has learned and nobody has acted on.
 *
 * The point of recording which format each task was: a client whose myths
 * reels do twice their average, and who has not had one made this month, is a
 * decision sitting in the data waiting for somebody to read the table.
 */
async function unusedLessons(): Promise<Decision[]> {
  const month = thisMonthKey();
  const clients = await query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM clients c
      WHERE ${onTheFloor()} AND COALESCE(is_personal,0) = 0 LIMIT 20`
  ).catch(() => []);

  const out: Decision[] = [];
  for (const c of clients) {
    const l = await learned(c.id).catch(() => null);
    if (!l || !l.formats.some((f) => f.proven)) continue;

    const next = nextFormat(l);
    if (!next) continue;
    const best = l.formats.find((f) => f.key === next.key);
    if (!best?.proven || best.lift < 1.3) continue;

    // Already making one this month? Then there is nothing to say.
    const made = await queryOne<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM deliverables WHERE client_id = ? AND month_key = ? AND content_type = ?",
      [c.id, month, next.key]
    ).catch(() => null);
    if (num(made?.n) > 0) continue;

    out.push({
      title: `${c.company_name} has not had a ${next.label} this month`,
      body:
        `${next.why} Nothing of that kind is on this month's board. ` +
        `The studio will write one from their own brand knowledge.`,
      link: `/studio?client=${c.id}`,
      urgency: Math.min(80, 40 + best.lift * 12 + best.confidence * 0.15),
      source: "content" as const,
    });
  }
  return out;
}

/* ------------------------------ deciding ------------------------------ */

/**
 * Everything worth considering, most urgent first.
 *
 * Exported on its own so the arithmetic can be read and tested without a model
 * key, a notification, or a night going by.
 */
export async function candidates(): Promise<Decision[]> {
  const groups = await Promise.all([
    overdueMoney().catch(() => []),
    lateWork().catch(() => []),
    emptyMonths().catch(() => []),
    brainFindings().catch(() => []),
    unusedLessons().catch(() => []),
  ]);
  return groups.flat().sort((a, b) => b.urgency - a.urgency);
}

/**
 * The sentence a person would say about the morning's top few.
 *
 * The only place a model is involved, and it cannot change what was chosen or
 * invent a number — it is given the decisions already made and asked to write
 * the line that goes at the top. Without a key it writes itself, which is why
 * nothing here depends on one.
 */
export async function brief(top: Decision[]): Promise<string> {
  const plain =
    top.length === 1
      ? `One thing needs you today: ${top[0].title.toLowerCase()}.`
      : `${top.length} things need you today, starting with ${top[0].title.toLowerCase()}.`;
  if (!top.length) return "";

  const { data } = await callJSON(
    [
      "You are the operations lead at a small digital-marketing agency, writing the one line",
      "that goes at the top of the morning's alerts for the person who runs it.",
      "You are given decisions that have already been made and ranked. Do not re-rank them,",
      "do not add anything that is not in front of you, and do not invent a number.",
      "One sentence, at most 25 words, plain and specific. Reply with JSON only.",
    ].join(" "),
    [
      "Today's decisions, most urgent first:",
      ...top.map((d, i) => `${i + 1}. [${d.source}] ${d.title} — ${d.body}`),
      "",
      'Reply as JSON: {"line": "the one sentence"}',
    ].join("\n")
  ).catch(() => ({ data: null }));

  const line = String((data as Record<string, unknown>)?.line ?? "").trim();
  return line || plain;
}

/**
 * Send it, unless it has already been said this week.
 *
 * The claim is the title, which is why titles carry no figures: the same
 * problem has to produce the same title tomorrow to be recognised as already
 * said. Returns false when it was a repeat.
 */
async function notifyOnce(d: Decision): Promise<boolean> {
  const seen = await queryOne<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM notifications
      WHERE type = 'ai_decision' AND title = ?
        AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [d.title.slice(0, 190), REPEAT_AFTER_DAYS]
  ).catch(() => null);
  if (num(seen?.n) > 0) return false;

  await notifyAdmins("ai_decision", d.title.slice(0, 190), d.body, d.link);
  return true;
}

export type DecisionRun = {
  considered: number;
  sent: Decision[];
  skipped: number;
  brief: string;
};

/**
 * One night's run: consider everything, send the few that matter.
 *
 * Safe to call twice — the second run sends nothing, because everything it
 * would send is already claimed.
 */
export async function runDecisions(limit = MAX_PER_RUN): Promise<DecisionRun> {
  const all = await candidates();

  /*
   * The cap is a day's worth, not a run's worth.
   *
   * Capping per run meant a second run carried on down the list — correct for
   * a nightly job and wrong for the button beside it, where pressing it three
   * times put nine things in everybody's bell. Counting what today has already
   * produced makes the button honest: it shows the day's decisions, and
   * pressing it again shows the same nothing the scheduler would find.
   */
  const today = await queryOne<{ n: unknown }>(
    `SELECT COUNT(DISTINCT title) AS n FROM notifications
      WHERE type = 'ai_decision' AND created_at >= CURDATE()`
  ).catch(() => null);
  const room = Math.max(0, limit - num(today?.n));

  const sent: Decision[] = [];
  let skipped = 0;
  for (const d of all) {
    if (sent.length >= room) {
      skipped += all.length - sent.length - skipped;
      break;
    }
    if (await notifyOnce(d)) sent.push(d);
    else skipped++;
  }

  /*
   * The brief goes out as its own notification, last, so it sits at the top of
   * the list — and only when there was more than one thing to tie together. A
   * one-line summary of one alert is the same alert twice.
   */
  // Its own type, so the summary never eats one of the day's three slots.
  const line = sent.length > 1 ? await brief(sent) : "";
  if (line) {
    await notifyAdmins("ai_brief", `This morning: ${line}`.slice(0, 190), line, "/ai");
  }

  return { considered: all.length, sent, skipped, brief: line };
}
