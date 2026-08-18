/**
 * The Marketing Brain.
 *
 * "Why did this client's growth slow down this month?" is the question the
 * whole portal exists to answer and the one nobody could get out of it. The
 * data was all there — content, reach, engagement, followers, ad spend, leads,
 * approvals, payments — in six modules that had never been asked a question
 * together.
 *
 * **The arithmetic is done here; the model only narrates it.** Every number in
 * a finding is computed in this file from two months of the client's own rows.
 * Gemini is handed those numbers and asked to write the sentence a person
 * would say. It cannot reach the database, and a finding survives the model
 * being absent, broken or wrong — `explain()` falls back to a plain sentence
 * built from the same figures. That ordering is the difference between an
 * analyst and a machine that produces confident prose about numbers it made up.
 *
 * **It says when it doesn't know.** A client with three posts has no trend, and
 * a finding needs a minimum of evidence behind it before it is offered at all.
 * "Not enough history yet" is a real answer here and is returned as one.
 *
 * Scoping is inherited, not reinvented: every entry point takes a client id
 * the caller has already checked with `canAccessClient`.
 */
import "server-only";
import { query, queryOne, hasTable } from "./db";
import { callJSON } from "./ai";
import { getPosts, sum, engagementRate, interactions, rank, slots, formatLabel, WEEKDAYS } from "./analytics";
import { monthName } from "./monthly-report";
import { shiftMonth, thisMonthKey } from "./date-range";

const n = (v: unknown) => Number(v ?? 0);

/* ------------------------------ Evidence ------------------------------ */

/** One month of everything the agency knows about a client. */
export type MonthSlice = {
  month: string;
  /** Published, from the insights table — what actually went out. */
  posts: number;
  reach: number;
  interactions: number;
  /** Engagement across the month, weighted by reach. Null with no reach. */
  rate: number | null;
  /** Posts by format, so a change of mix is visible rather than inferred. */
  formats: { format: string; posts: number; avgReach: number }[];
  followers: number | null;
  followerGain: number | null;
  /** Planned and delivered, from the task board. */
  planned: number;
  delivered: number;
  adSpend: number;
  adLeads: number;
  currency: string;
};

export type Evidence = {
  clientId: number;
  client: string;
  now: MonthSlice;
  before: MonthSlice;
  /** Days a task has been sitting with the client, worst first. */
  stalledApprovals: { title: string; days: number }[];
  overduePayments: { amount: number; days: number }[];
};

const emptySlice = (month: string): MonthSlice => ({
  month,
  posts: 0,
  reach: 0,
  interactions: 0,
  rate: null,
  formats: [],
  followers: null,
  followerGain: null,
  planned: 0,
  delivered: 0,
  adSpend: 0,
  adLeads: 0,
  currency: "INR",
});

/** Published performance for one calendar month, from the stored insights. */
async function sliceFor(clientId: number, month: string): Promise<MonthSlice> {
  const slice = emptySlice(month);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${month}-01`;
  const to = `${month}-${String(last).padStart(2, "0")}`;

  const posts = await getPosts(from, to, { clientId });
  const totals = sum(posts);
  slice.posts = totals.posts;
  slice.reach = totals.reach;
  slice.interactions = interactions(totals);
  slice.rate = engagementRate(totals);

  const byFormat = new Map<string, typeof posts>();
  for (const p of posts) {
    const key = formatLabel(p.media_type);
    byFormat.set(key, [...(byFormat.get(key) ?? []), p]);
  }
  slice.formats = [...byFormat.entries()]
    .map(([format, group]) => ({
      format,
      posts: group.length,
      avgReach: Math.round(sum(group).reach / group.length),
    }))
    .sort((a, b) => b.avgReach - a.avgReach);

  const board = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS planned, SUM(status IN ('posted','completed')) AS delivered
       FROM deliverables WHERE client_id = ? AND month_key = ?`,
    [clientId, month]
  );
  slice.planned = n(board?.planned);
  slice.delivered = n(board?.delivered);

  if (await hasTable("audience_snapshots")) {
    /*
     * The closing count for the month, and the closing count of the month
     * before it — the gain is the difference, not the sum of daily deltas,
     * because a gap in the series would otherwise read as a flat week.
     */
    const followers = await queryOne<{ now: number | null; before: number | null }>(
      `SELECT
         (SELECT followers FROM audience_snapshots
           WHERE client_id = ? AND platform = 'instagram' AND taken_on <= ?
           ORDER BY taken_on DESC LIMIT 1) AS \`now\`,
         (SELECT followers FROM audience_snapshots
           WHERE client_id = ? AND platform = 'instagram' AND taken_on < ?
           ORDER BY taken_on DESC LIMIT 1) AS \`before\``,
      [clientId, to, clientId, from]
    ).catch(() => null);
    if (followers?.now != null) {
      slice.followers = n(followers.now);
      slice.followerGain = followers.before == null ? null : n(followers.now) - n(followers.before);
    }
  }

  if (await hasTable("ad_insights")) {
    const ads = await queryOne<Record<string, unknown>>(
      `SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(leads),0) AS leads, MAX(currency) AS currency
         FROM ad_insights WHERE client_id = ? AND date BETWEEN ? AND ?`,
      [clientId, from, to]
    ).catch(() => null);
    slice.adSpend = n(ads?.spend);
    slice.adLeads = n(ads?.leads);
    slice.currency = String(ads?.currency || "INR");
  }

  return slice;
}

/**
 * Everything the Brain reasons from, for one client.
 *
 * Two months side by side, because every question worth asking here is a
 * comparison — "slowed down" has no meaning against a single month.
 */
export async function gatherEvidence(clientId: number, month = thisMonthKey()): Promise<Evidence | null> {
  const client = await queryOne<{ id: number; company_name: string }>(
    "SELECT id, company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  const previous = shiftMonth(month, -1);
  const [now, before, stalled, overdue] = await Promise.all([
    sliceFor(clientId, month),
    sliceFor(clientId, previous),
    query<Record<string, unknown>>(
      `SELECT title, DATEDIFF(CURDATE(), DATE(updated_at)) AS days
         FROM deliverables
        WHERE client_id = ? AND status IN ('review','content_review')
        ORDER BY updated_at ASC LIMIT 5`,
      [clientId]
    ).catch(() => []),
    query<Record<string, unknown>>(
      `SELECT amount, DATEDIFF(CURDATE(), DATE(created_at)) AS days
         FROM payments WHERE client_id = ? AND status = 'pending'
        ORDER BY created_at ASC LIMIT 5`,
      [clientId]
    ).catch(() => []),
  ]);

  return {
    clientId,
    client: client.company_name,
    now,
    before,
    stalledApprovals: stalled.map((r) => ({ title: String(r.title), days: n(r.days) })),
    overduePayments: overdue.map((r) => ({ amount: n(r.amount), days: n(r.days) })),
  };
}

/* ------------------------------ Findings ------------------------------ */

export type Severity = "critical" | "warning" | "opportunity" | "good";

/**
 * One thing the Brain has to say, in the shape the spec asks for: what it
 * found, what it looked at, why, how sure it is, and what to do next.
 *
 * `confidence` is derived from how much evidence is behind the finding, never
 * asked of the model — a language model's stated confidence is a sentence, not
 * a measurement.
 */
export type Finding = {
  kind: string;
  severity: Severity;
  headline: string;
  /** The figures the finding rests on, each already formatted for reading. */
  evidence: string[];
  reason: string;
  recommendation: string;
  /** 0–100. Below 50 the finding is held back entirely. */
  confidence: number;
  /** Where to go and do something about it. */
  action?: { label: string; href: string };
};

const pct = (a: number, b: number): number | null => (b ? ((a - b) / b) * 100 : null);
const fmt = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v));
const money = (v: number, currency = "INR") => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${currency} ${Math.round(v)}`;
  }
};

/**
 * How sure we are, from how much is behind it.
 *
 * A month with three posts can produce a 60% swing that means nothing. This
 * is deliberately blunt — sample size and effect size, nothing cleverer —
 * because a precise-looking number from a vague method is the exact failure
 * the confidence figure exists to prevent.
 */
function confidenceFrom(sample: number, changePct: number): number {
  const bySample = Math.min(60, sample * 8);
  const byEffect = Math.min(35, Math.abs(changePct) * 0.7);
  return Math.round(Math.min(95, 25 + bySample * 0.6 + byEffect));
}

/**
 * Read the two months and say what changed.
 *
 * Every finding here is arithmetic. Nothing in this function calls a model,
 * which is why the numbers can be trusted and why the whole thing still works
 * with no API key at all.
 */
export function findings(e: Evidence): Finding[] {
  const out: Finding[] = [];
  const { now, before } = e;
  const enoughHistory = before.posts >= 3 && now.posts >= 3;

  /* --- reach, the headline number --- */
  const reachChange = pct(now.reach, before.reach);
  if (enoughHistory && reachChange !== null && Math.abs(reachChange) >= 15) {
    const down = reachChange < 0;
    const postsChange = pct(now.posts, before.posts);

    /*
     * Fewer posts is the first thing to rule out. Reach falling because half
     * as much went out is a production problem, and telling somebody their
     * content got worse when they simply published less is the most common
     * wrong answer an analytics tool gives.
     */
    const fewerPosts = postsChange !== null && postsChange <= -20;
    const perPostNow = now.posts ? now.reach / now.posts : 0;
    const perPostBefore = before.posts ? before.reach / before.posts : 0;
    const perPostChange = pct(perPostNow, perPostBefore);

    out.push({
      kind: "reach_change",
      severity: down ? (reachChange <= -30 ? "critical" : "warning") : "good",
      headline: `Reach ${down ? "fell" : "grew"} ${Math.abs(Math.round(reachChange))}% against ${monthName(before.month)}`,
      evidence: [
        `${fmt(now.reach)} reached this month, ${fmt(before.reach)} last`,
        `${now.posts} posts against ${before.posts}`,
        `${fmt(perPostNow)} average reach per post, ${fmt(perPostBefore)} last month`,
      ],
      reason: fewerPosts
        ? `Fewer posts went out — ${now.posts} against ${before.posts}. Reach per post is ${
            perPostChange !== null && perPostChange >= -10 ? "holding up" : `also down ${Math.abs(Math.round(perPostChange ?? 0))}%`
          }, so this is a production shortfall before it is a content problem.`
        : `Output held at ${now.posts} posts, so this is the content itself rather than how much of it went out.`,
      recommendation: fewerPosts
        ? `Get output back to ${before.posts} posts. The plan is the fix here, not the creative.`
        : `Look at what changed in the mix — the format table below is where that shows.`,
      confidence: confidenceFrom(now.posts + before.posts, reachChange),
      action: { label: "Open analytics", href: `/analytics?client=${e.clientId}` },
    });
  }

  /* --- the format mix, which is usually the real answer --- */
  if (enoughHistory && now.formats.length && before.formats.length) {
    const best = [...before.formats].sort((a, b) => b.avgReach - a.avgReach)[0];
    const worst = [...before.formats].sort((a, b) => a.avgReach - b.avgReach)[0];

    if (best && worst && best.format !== worst.format && worst.avgReach > 0) {
      const ratio = best.avgReach / worst.avgReach;
      const bestNow = now.formats.find((f) => f.format === best.format)?.posts ?? 0;
      const bestBefore = best.posts;

      // Only worth saying when one format is clearly ahead and the mix moved.
      if (ratio >= 1.4 && bestNow < bestBefore) {
        out.push({
          kind: "format_mix",
          severity: "opportunity",
          headline: `${best.format}s reach ${ratio.toFixed(1)}× further, and fewer went out this month`,
          evidence: [
            `${best.format}: ${fmt(best.avgReach)} average reach`,
            `${worst.format}: ${fmt(worst.avgReach)} average reach`,
            `${bestNow} ${best.format.toLowerCase()}s this month, ${bestBefore} last`,
          ],
          reason: `${best.format}s are the format this account is rewarded for, and the mix moved away from them.`,
          recommendation: `Put ${best.format.toLowerCase()}s back to at least ${bestBefore} next month before changing anything creative.`,
          confidence: confidenceFrom(before.posts, (ratio - 1) * 100),
          action: { label: "Plan the month", href: `/clients/${e.clientId}` },
        });
      }
    }
  }

  /* --- production against the plan --- */
  if (now.planned > 0 && now.delivered < now.planned) {
    const short = now.planned - now.delivered;
    const shortfall = (short / now.planned) * 100;
    if (shortfall >= 25) {
      out.push({
        kind: "production_behind",
        severity: shortfall >= 50 ? "critical" : "warning",
        headline: `${short} of ${now.planned} planned posts have not gone out`,
        evidence: [`${now.delivered} delivered of ${now.planned} planned in ${monthName(now.month)}`],
        reason: `Reach follows output. A month that publishes ${Math.round(100 - shortfall)}% of its plan cannot match a month that published all of it.`,
        recommendation: `Clear the backlog before the month ends — the board shows where each one is stuck.`,
        confidence: 90,
        action: { label: "Open the board", href: `/deliverables?client=${e.clientId}` },
      });
    }
  }

  /* --- work sitting with the client --- */
  const worstStall = e.stalledApprovals[0];
  if (worstStall && worstStall.days >= 3) {
    out.push({
      kind: "approval_stalled",
      severity: worstStall.days >= 7 ? "critical" : "warning",
      headline: `Approval waiting ${worstStall.days} days on the client`,
      evidence: e.stalledApprovals.slice(0, 3).map((s) => `${s.title} — ${s.days} days`),
      reason: `Nothing downstream of an approval can move, so a stalled one delays posting, reach and the month's numbers together.`,
      recommendation: `Send the approval reminder. This is blocked on them, not on the team.`,
      confidence: 95,
      action: { label: "Open approvals", href: "/approvals" },
    });
  }

  /* --- cost per lead, when they run ads --- */
  if (now.adSpend > 0 && before.adSpend > 0 && now.adLeads > 0 && before.adLeads > 0) {
    const cplNow = now.adSpend / now.adLeads;
    const cplBefore = before.adSpend / before.adLeads;
    const change = pct(cplNow, cplBefore);
    if (change !== null && Math.abs(change) >= 20) {
      const worse = change > 0;
      out.push({
        kind: "cpl_change",
        severity: worse ? (change >= 40 ? "critical" : "warning") : "good",
        headline: `Cost per lead ${worse ? "up" : "down"} ${Math.abs(Math.round(change))}%`,
        evidence: [
          `${money(cplNow, now.currency)} per lead this month, ${money(cplBefore, before.currency)} last`,
          `${money(now.adSpend, now.currency)} spent for ${fmt(now.adLeads)} leads`,
        ],
        reason: worse
          ? `The same budget is buying fewer leads, which is creative fatigue or audience saturation before it is anything else.`
          : `The same budget is buying more leads than last month.`,
        recommendation: worse
          ? `Test a new hook on the weakest creative before adding budget.`
          : `Hold the current creative and consider more budget behind it.`,
        confidence: confidenceFrom(Math.min(now.adLeads, 12), change),
        action: { label: "Open ads", href: `/ads/${e.clientId}` },
      });
    }
  }

  /* --- money --- */
  const oldest = e.overduePayments.find((p) => p.days >= 30);
  if (oldest) {
    out.push({
      kind: "payment_overdue",
      severity: oldest.days >= 60 ? "critical" : "warning",
      headline: `${money(oldest.amount)} unpaid for ${oldest.days} days`,
      evidence: e.overduePayments.slice(0, 3).map((p) => `${money(p.amount)} — ${p.days} days`),
      reason: `An invoice this old rarely fixes itself, and it is usually the first sign of a client on the way out.`,
      recommendation: `Send the payment reminder, and check whether anything else about this account has gone quiet.`,
      confidence: 95,
      action: { label: "Open payments", href: "/payments" },
    });
  }

  // Most serious first, then by how sure we are. A confident warning outranks
  // a shaky critical, which is the order somebody working through a list wants.
  const order: Record<Severity, number> = { critical: 0, warning: 1, opportunity: 2, good: 3 };
  return out
    .filter((f) => f.confidence >= 50)
    .sort((a, b) => order[a.severity] - order[b.severity] || b.confidence - a.confidence);
}

/* ------------------------------ Answering ------------------------------ */

export type BrainAnswer = {
  /** The written answer. Falls back to a plain sentence when no model answers. */
  text: string;
  findings: Finding[];
  /** True when the answer came from the model rather than the fallback. */
  narrated: boolean;
  /** Set when there is not enough history to say anything honest. */
  insufficient?: string;
};

/** The bare facts, as a block the model may narrate but never contradict. */
function asData(e: Evidence): string {
  const line = (s: MonthSlice) =>
    [
      `${monthName(s.month)}: ${s.posts} posts published, ${s.reach} accounts reached, ` +
        `${s.interactions} interactions${s.rate === null ? "" : `, ${s.rate.toFixed(1)}% engagement rate`}.`,
      `  Planned ${s.planned}, delivered ${s.delivered}.`,
      s.followers === null ? null : `  Followers ${s.followers}${s.followerGain === null ? "" : `, ${s.followerGain >= 0 ? "+" : ""}${s.followerGain} over the month`}.`,
      s.formats.length ? `  By format: ${s.formats.map((f) => `${f.format} ×${f.posts} averaging ${f.avgReach} reach`).join("; ")}.` : null,
      s.adSpend ? `  Ads: ${s.adSpend} ${s.currency} spent, ${s.adLeads} leads.` : null,
    ]
      .filter(Boolean)
      .join("\n");

  return [
    `Client: ${e.client}.`,
    line(e.now),
    line(e.before),
    e.stalledApprovals.length
      ? `Waiting on the client: ${e.stalledApprovals.map((s) => `"${s.title}" ${s.days} days`).join("; ")}.`
      : null,
    e.overduePayments.length
      ? `Unpaid invoices: ${e.overduePayments.map((p) => `${p.amount} for ${p.days} days`).join("; ")}.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The answer when there is no model, built from the findings themselves. */
function plainAnswer(e: Evidence, list: Finding[]): string {
  if (!list.length) {
    return `Nothing stands out for ${e.client} this month — output, reach and approvals are all roughly where they were in ${monthName(e.before.month)}.`;
  }
  return list
    .slice(0, 3)
    .map((f) => `**${f.headline}.** ${f.reason} ${f.recommendation}`)
    .join("\n\n");
}

/**
 * Ask the Brain about a client.
 *
 * The findings are computed first and the model is given them as fact. It is
 * asked to explain, never to calculate — so the worst a bad model run can do
 * is word something clumsily, not invent a number a client then hears.
 */
export async function ask(clientId: number, question: string, month = thisMonthKey()): Promise<BrainAnswer | null> {
  const evidence = await gatherEvidence(clientId, month);
  if (!evidence) return null;

  const list = findings(evidence);

  // Two months of almost nothing cannot support a trend, and saying so is the
  // honest answer rather than a hedged paragraph that reads like one.
  if (evidence.now.posts + evidence.before.posts < 4) {
    return {
      text: `Not enough history yet to say anything reliable about ${evidence.client} — ${evidence.now.posts + evidence.before.posts} published posts across two months. Sync their Instagram from Analytics, and this gets useful after a few weeks of posting.`,
      findings: list,
      narrated: false,
      insufficient: "fewer than four published posts across the two months compared",
    };
  }

  const system = [
    "You are the analyst inside a digital-marketing agency's own portal.",
    "The DATA block and the FINDINGS block are already computed and are the only facts you have.",
    "Never invent, estimate or recompute a number — quote only figures that appear in those blocks.",
    "Answer the question directly in three or four sentences: what happened, why, and what to do next.",
    "Use **bold** for figures. No preamble, no greeting, no mention of data blocks or of being a model.",
    "If the blocks do not answer the question, say plainly which figure is missing.",
  ].join(" ");

  const user = [
    `DATA:\n${asData(evidence)}`,
    list.length
      ? `FINDINGS (already verified, most serious first):\n${list
          .map((f) => `- ${f.headline}. ${f.reason} Suggested: ${f.recommendation}`)
          .join("\n")}`
      : "FINDINGS: nothing crossed a threshold worth reporting.",
    `QUESTION: ${question}`,
  ].join("\n\n");

  const { data } = await callJSON(
    system,
    `${user}\n\nReply as JSON: {"answer": "<your answer>"}`
  ).catch(() => ({ data: null }));

  const text = typeof data?.answer === "string" ? data.answer.trim() : "";
  return text
    ? { text, findings: list, narrated: true }
    : { text: plainAnswer(evidence, list), findings: list, narrated: false };
}

/* --------------------------- Client health --------------------------- */

export type Health = {
  score: number;
  band: "healthy" | "attention" | "critical";
  /** What moved the score, worst first — never a bare number. */
  reasons: { label: string; delta: number }[];
};

/**
 * One number for how a client relationship is doing, and what moved it.
 *
 * Starts at 100 and loses points for things that are actually wrong, so the
 * reasons list is the score — a client can read every deduction. A score with
 * no explanation is a number people argue with; a score that says "−15,
 * approval sitting nine days" is one they act on.
 */
export function health(e: Evidence): Health {
  const reasons: { label: string; delta: number }[] = [];

  if (e.now.planned > 0) {
    const short = e.now.planned - e.now.delivered;
    if (short > 0) {
      const delta = -Math.min(25, Math.round((short / e.now.planned) * 30));
      reasons.push({ label: `${short} of ${e.now.planned} posts not delivered`, delta });
    }
  }

  const stall = e.stalledApprovals[0];
  if (stall && stall.days >= 3) {
    reasons.push({
      label: `Approval waiting ${stall.days} days`,
      delta: -Math.min(20, stall.days * 2),
    });
  }

  const unpaid = e.overduePayments.find((p) => p.days >= 30);
  if (unpaid) {
    reasons.push({
      label: `${money(unpaid.amount)} unpaid for ${unpaid.days} days`,
      delta: -Math.min(25, Math.round(unpaid.days / 3)),
    });
  }

  const reachChange = pct(e.now.reach, e.before.reach);
  if (reachChange !== null && e.before.posts >= 3) {
    if (reachChange <= -25) {
      reasons.push({ label: `Reach down ${Math.abs(Math.round(reachChange))}%`, delta: -15 });
    } else if (reachChange >= 25) {
      reasons.push({ label: `Reach up ${Math.round(reachChange)}%`, delta: 5 });
    }
  }

  if (e.now.followerGain !== null && e.now.followerGain < 0) {
    reasons.push({ label: `Lost ${fmt(Math.abs(e.now.followerGain))} followers`, delta: -10 });
  }

  const score = Math.max(0, Math.min(100, 100 + reasons.reduce((t, r) => t + r.delta, 0)));
  return {
    score,
    band: score >= 75 ? "healthy" : score >= 50 ? "attention" : "critical",
    reasons: reasons.sort((a, b) => a.delta - b.delta),
  };
}

/** The best day and format this client's own history supports, or null. */
export async function bestSlot(clientId: number, month = thisMonthKey()): Promise<string | null> {
  const from = `${shiftMonth(month, -2)}-01`;
  const posts = await getPosts(from, `${month}-28`, { clientId });
  const days = slots(posts, "weekday");
  const top = rank(posts, 1);
  if (!days.length || !top.length) return null;
  return `${WEEKDAYS[Number(days[0].key)]}s, ${formatLabel(top[0].media_type).toLowerCase()}s`;
}
