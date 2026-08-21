/**
 * The portal assistant.
 *
 * Security model: the language model never touches the database and never
 * receives a query it can shape. This module computes a snapshot that is
 * already filtered to what the asking user is allowed to see, and only that
 * snapshot is sent. A crm cannot coax another client's numbers out of it,
 * because those numbers were never in the prompt; a designer only ever sees
 * their own workload. Role isolation is a property of the data, not of how
 * well the model follows instructions.
 */
import "server-only";
import { nowUtc } from "./posting";
import { query, queryOne, hasColumn } from "./db";
import { env } from "./env";
import type { SessionUser } from "./auth";
import { crmClientIds } from "./crm";
import { needsRawFootageSql } from "./raw-footage";
import {
  getPosts,
  followerBoard,
  sum,
  slots,
  rank,
  engagementRate,
  interactions,
  formatLabel,
  WEEKDAYS,
  type PostRow,
} from "./analytics";
import { leadSummary } from "./leads";

/* ----------------------------- Snapshot ----------------------------- */

export type Snapshot = {
  scope: string;
  month: string;
  clients?: { total: number; active: number };
  content: {
    month_planned: number;
    month_approved: number;
    due_today: number;
    overdue: number;
    awaiting_client: number;
    changes_requested: number;
    waiting_for_raw: number;
    in_editing: number;
    scheduled: number;
    posted_this_month: number;
    not_posted: number;
    /** Waiting on the client to send footage — blocked on them, not on us. */
    no_footage: number;
    /** Went out on the 24-hour rule, with no word from the client. */
    auto_approved: number;
    /** Publishing was attempted and failed, as opposed to not yet tried. */
    posting_failed: number;
  };
  /** Clients the agency can actually message. The rest are outside every reminder. */
  whatsapp?: { clients: number; reachable: number };
  money?: { received_this_month: number; pending: number };
  by_client?: { client: string; planned: number; approved: number }[];
  today_list?: { title: string; client: string; status: string; due: string | null }[];
  /**
   * How the month's published work actually did.
   *
   * The assistant could describe everything the agency made and nothing about
   * whether any of it worked, which is the half a client asks about. Absent
   * rather than zeroed when the analytics table has not been applied — a
   * confident "0 reach" is worse than "I don't have that".
   */
  performance?: {
    posts: number;
    reach: number;
    interactions: number;
    /** Engagement as a share of reach, across the month. */
    rate: number | null;
    followers: number | null;
    follower_growth: number | null;
    best_day: string | null;
    best_format: string | null;
    /** First lines of the month's best posts — what to make more of. */
    top: { caption: string; format: string; reach: number; rate: number | null }[];
  };
  /** The pipeline before a client exists. Admins and crm only. */
  leads?: { open: number; overdue: number; won_this_month: number; won_value: number };
};

const n = (v: unknown) => Number(v ?? 0);

/**
 * Roles whose assistant answers cover their own worklist, not the agency.
 *
 * The fallback at the bottom of `scopeFor` is "the whole agency", so a role
 * that isn't named here quietly gets client lists and per-client totals. That
 * default is right for admins and wrong for everyone who does the work.
 */
const PERSONAL_SCOPE: SessionUser["role"][] = ["poster_designer", "video_editor"];

/** What this user is allowed to see, expressed as SQL fragments. */
async function scopeFor(user: SessionUser) {
  if (PERSONAL_SCOPE.includes(user.role)) {
    return { label: "your own assigned tasks", where: `d.assigned_to = ${Math.trunc(user.id)}` };
  }
  if (user.role === "crm") {
    const ids = await crmClientIds(user);
    if (!ids || ids.length === 0) return { label: "your assigned clients (none yet)", where: "1=0" };
    const list = ids.map((v) => Math.trunc(Number(v))).join(",");
    return { label: "your assigned clients", where: `d.client_id IN (${list})` };
  }
  return { label: "the whole agency", where: "1=1" };
}

/**
 * This month's published work, as figures.
 *
 * Reads the stored insights rather than Instagram — the assistant answers in
 * a second or it does not get asked twice, and these numbers were pulled
 * overnight anyway. Returns null when nothing has been published or the table
 * has not been applied, so the snapshot simply has no performance section
 * rather than one full of zeroes.
 */
async function monthPerformance(clientIds: number[] | null): Promise<Snapshot["performance"] | null> {
  const month = new Date().toISOString().slice(0, 7);
  const posts = await getPosts(`${month}-01`, new Date().toISOString().slice(0, 10), {
    clientIds,
  });
  if (!posts.length) return null;

  const totals = sum(posts);
  const days = slots(posts, "weekday");
  const formats = new Map<string, PostRow[]>();
  for (const p of posts) {
    const key = formatLabel(p.media_type);
    formats.set(key, [...(formats.get(key) ?? []), p]);
  }
  const bestFormat = [...formats.entries()]
    .map(([label, group]) => ({ label, avg: sum(group).reach / group.length }))
    .sort((a, b) => b.avg - a.avg)[0];

  const followers = await followerBoard().catch(() => new Map());
  const mine = [...followers.entries()].filter(
    ([id]) => !clientIds || clientIds.includes(id as number)
  );

  return {
    posts: totals.posts,
    reach: totals.reach,
    interactions: interactions(totals),
    rate: engagementRate(totals),
    followers: mine.length ? mine.reduce((t, [, v]) => t + v.followers, 0) : null,
    follower_growth: mine.some(([, v]) => v.growth !== null)
      ? mine.reduce((t, [, v]) => t + (v.growth ?? 0), 0)
      : null,
    best_day: days[0] ? WEEKDAYS[Number(days[0].key)] : null,
    best_format: bestFormat?.label ?? null,
    top: rank(posts, 3).map((p) => ({
      caption: (p.caption?.split("\n")[0] ?? "").slice(0, 80) || "No caption",
      format: formatLabel(p.media_type),
      reach: p.reach,
      rate: engagementRate(p),
    })),
  };
}

export async function buildSnapshot(user: SessionUser): Promise<Snapshot> {
  const { label, where } = await scopeFor(user);
  const month = new Date().toISOString().slice(0, 7);
  const isAdmin = user.role === "super_admin" || user.role === "admin";

  const cloudOk = await hasColumn("deliverables", "cloud_video_key");
  // Added by the WhatsApp migration. Without the guard a database that has not
  // run it loses the whole snapshot — one missing column would take out every
  // answer the assistant gives, not just the auto-approval count.
  const waOk = await hasColumn("deliverables", "wa_approved_by");

  const content = await queryOne<Record<string, unknown>>(
    `SELECT
       SUM(d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')) AS month_planned,
       SUM(d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')
           AND d.status IN ('approved','scheduled','posted','completed')) AS month_approved,
       SUM(d.due_date = CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')) AS due_today,
       SUM(d.due_date < CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')) AS overdue,
       SUM(d.status IN ('content_review','review')) AS awaiting_client,
       SUM(d.status = 'changes_requested') AS changes_requested,
       SUM(d.status = 'waiting_for_raw') AS waiting_for_raw,
       SUM(d.status IN ('raw_uploaded','editing','caption_ready')) AS in_editing,
       SUM(d.status = 'scheduled') AS scheduled,
       SUM(d.status IN ('posted','completed')
           AND d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')) AS posted_this_month,
       SUM(d.status = 'scheduled' AND d.scheduled_at IS NOT NULL
           AND d.scheduled_at < ? - INTERVAL 30 MINUTE
           AND d.instagram_status <> 'posted') AS not_posted,
       /* The three the assistant could not see, and so answered wrongly or
          not at all: work blocked on the client rather than on us, work that
          went out without anyone approving it, and work whose posting
          actually failed as opposed to merely not having happened yet. */
       SUM(d.status IN ('pending','waiting_for_raw')
           AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')
           AND ${needsRawFootageSql("d")}) AS no_footage,
       ${waOk ? `SUM(d.wa_approved_by = 'Auto-approved after 24h'
           AND d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m'))` : "0"} AS auto_approved,
       SUM(d.instagram_status = 'failed') AS posting_failed
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE c.status <> 'churned' AND ${where}`,
    // The app's UTC, like the publisher's own due-check — the assistant
    // reporting a different number of late posts from the dashboard is worse
    // than it not knowing.
    [nowUtc()]
  );

  /*
   * How many clients the agency can actually reach on WhatsApp.
   *
   * Every reminder built this week goes through a linked group, so a client
   * without one is silently outside all of it. The assistant was confidently
   * reporting "3 waiting for approval" with no way to know that two of those
   * clients could not be chased at all.
   */
  const reach = await queryOne<{ total: number; linked: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(EXISTS(
              SELECT 1 FROM whatsapp_groups g
               WHERE g.client_id = c.id AND g.is_active = 1)),0) AS linked
       FROM clients c WHERE c.status <> 'churned'`
  ).catch(() => null);

  const snap: Snapshot = {
    scope: label,
    month,
    content: {
      month_planned: n(content?.month_planned),
      month_approved: n(content?.month_approved),
      due_today: n(content?.due_today),
      overdue: n(content?.overdue),
      awaiting_client: n(content?.awaiting_client),
      changes_requested: n(content?.changes_requested),
      waiting_for_raw: n(content?.waiting_for_raw),
      in_editing: n(content?.in_editing),
      scheduled: n(content?.scheduled),
      posted_this_month: n(content?.posted_this_month),
      not_posted: n(content?.not_posted),
      no_footage: n(content?.no_footage),
      auto_approved: n(content?.auto_approved),
      posting_failed: n(content?.posting_failed),
    },
  };
  if (reach) snap.whatsapp = { clients: n(reach.total), reachable: n(reach.linked) };

  // Today's worklist — small enough to quote back verbatim.
  snap.today_list = (
    await query<Record<string, unknown>>(
      `SELECT d.title, c.company_name, d.status, d.due_date
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where}
          AND d.due_date <= CURDATE()
          AND d.status NOT IN ('posted','completed','cancelled','rejected')
        ORDER BY d.due_date ASC LIMIT 10`
    )
  ).map((r) => ({
    title: String(r.title),
    client: String(r.company_name),
    status: String(r.status),
    due: r.due_date ? String(r.due_date) : null,
  }));

  // Per-client split: not meaningful for a personal worklist, and it would
  // hand someone the agency's client list as a side effect.
  if (!PERSONAL_SCOPE.includes(user.role)) {
    snap.by_client = (
      await query<Record<string, unknown>>(
        `SELECT c.company_name,
                SUM(d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')) AS planned,
                SUM(d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')
                    AND d.status IN ('approved','scheduled','posted','completed')) AS approved
           FROM deliverables d JOIN clients c ON c.id = d.client_id
          WHERE c.status <> 'churned' AND ${where}
          GROUP BY c.id ORDER BY c.company_name LIMIT 15`
      )
    ).map((r) => ({
      client: String(r.company_name),
      planned: n(r.planned),
      approved: n(r.approved),
    }));

    const clients = await queryOne<Record<string, unknown>>(
      user.role === "crm"
        ? `SELECT COUNT(*) AS total, SUM(status='active') AS active FROM clients
            WHERE status <> 'churned' AND id IN (SELECT client_id FROM client_crm_access WHERE crm_user_id = ${Math.trunc(user.id)})`
        : `SELECT COUNT(*) AS total, SUM(status='active') AS active FROM clients WHERE status <> 'churned'`
    );
    snap.clients = { total: n(clients?.total), active: n(clients?.active) };
  }

  /*
   * Performance, and the pipeline — for everyone who isn't scoped to their own
   * worklist.
   *
   * A designer's assistant answers about their tasks; reach across the agency
   * is not theirs to be told, and the leads board is not on their nav at all.
   * Both are scoped by the same crm client list the rest of the snapshot uses,
   * so a crm sees their own accounts' numbers and nobody else's.
   */
  if (!PERSONAL_SCOPE.includes(user.role)) {
    const ids = user.role === "crm" ? await crmClientIds(user) : null;
    const [perf, pipeline] = await Promise.all([
      monthPerformance(ids).catch(() => null),
      isAdmin || user.role === "crm" ? leadSummary().catch(() => null) : Promise.resolve(null),
    ]);
    if (perf) snap.performance = perf;
    if (pipeline) {
      snap.leads = {
        open: pipeline.open,
        overdue: pipeline.overdue,
        won_this_month: pipeline.wonThisMonth,
        won_value: pipeline.wonValueThisMonth,
      };
    }
  }

  // Money is admin-only, and simply absent otherwise — not hidden in the prompt.
  if (isAdmin) {
    const pay = await queryOne<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid'
           AND DATE_FORMAT(paid_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN amount END),0) AS received,
         COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending
       FROM payments`
    );
    snap.money = { received_this_month: n(pay?.received), pending: n(pay?.pending) };
  }

  void cloudOk;
  return snap;
}

/* ------------------------------ Answering ------------------------------ */

const money = (v: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v);

const count = (v: number) => new Intl.NumberFormat("en-IN").format(v);

/**
 * Deterministic answers for the quick questions. These never call the model —
 * a count should not be able to hallucinate, and it costs nothing.
 */
function fastAnswer(q: string, s: Snapshot): string | null {
  const t = q.toLowerCase();
  const c = s.content;

  if (/plann?ed.*(month|this month)|videos.*month|month.*videos/.test(t)) {
    return `**${c.month_planned}** planned for ${s.month} across ${s.scope} — **${c.month_approved}** already approved.`;
  }
  if (/today/.test(t)) {
    if (!c.due_today && !s.today_list?.length) return `Nothing is due today across ${s.scope}. 🎉`;
    const lines = (s.today_list ?? [])
      .slice(0, 8)
      .map((r) => `- ${r.title} — ${r.client} (${r.status.replace(/_/g, " ")})`)
      .join("\n");
    return `**${c.due_today}** due today${c.overdue ? `, plus **${c.overdue}** overdue` : ""}.\n\n${lines}`;
  }
  if (/pending approval|awaiting|approval/.test(t)) {
    return `**${c.awaiting_client}** waiting on the client right now, and **${c.changes_requested}** came back with changes requested.`;
  }
  if (/revision|change/.test(t)) {
    return `**${c.changes_requested}** items have changes requested.`;
  }
  if (/not posted|missed|fail/.test(t)) {
    return c.not_posted
      ? `**${c.not_posted}** scheduled post${c.not_posted === 1 ? "" : "s"} missed their slot and still haven't gone out. They're listed on your dashboard under "Not posted".`
      : `Nothing has missed its posting slot. **${c.scheduled}** currently scheduled.`;
  }
  if (/revenue|payment|money|invoice|paid/.test(t)) {
    return s.money
      ? `**${money(s.money.received_this_month)}** received this month, **${money(s.money.pending)}** still pending.`
      : `Revenue isn't part of your access — your assistant only covers content and workload.`;
  }

  /*
   * Performance. Kept below the workload questions on purpose: "how many
   * posts" is about the plan and is answered above, and only a question that
   * names reach, engagement or growth is asking about results.
   */
  if (/reach|engagement|perform|how did|results|views|follower|growth|grew/.test(t)) {
    const p = s.performance;
    if (!p) {
      return `I don't have performance figures yet — nothing has been read back from Instagram for ${s.month}. Analytics can pull them in.`;
    }
    const lines = [
      `**${count(p.reach)}** accounts reached across **${p.posts}** post${p.posts === 1 ? "" : "s"} this month, ` +
        `with **${count(p.interactions)}** interactions${p.rate === null ? "" : ` — a **${p.rate.toFixed(1)}%** engagement rate`}.`,
    ];
    if (p.followers !== null) {
      lines.push(
        `Followers: **${count(p.followers)}**${
          p.follower_growth === null
            ? ""
            : ` (${p.follower_growth >= 0 ? "+" : ""}${count(p.follower_growth)} this month)`
        }.`
      );
    }
    if (p.best_format || p.best_day) {
      lines.push(
        `Best so far: ${[p.best_format ? `**${p.best_format}s**` : null, p.best_day ? `posted on **${p.best_day}**` : null]
          .filter(Boolean)
          .join(", ")}.`
      );
    }
    return lines.join("\n\n");
  }

  // What to make next — answered from what already worked, not invented.
  if (/what should we post|content idea|idea|next post|suggest/.test(t) && s.performance?.top.length) {
    const p = s.performance;
    return [
      `Going on this month's numbers${p.best_format ? `, **${p.best_format}s** are reaching furthest` : ""}${p.best_day ? ` and **${p.best_day}** is the strongest day` : ""}.`,
      "Your three best posts this month were:",
      ...p.top.map(
        (x) => `- ${x.caption} — ${x.format}, ${count(x.reach)} reached${x.rate === null ? "" : `, ${x.rate.toFixed(1)}% engaged`}`
      ),
      "More of that shape is the safest bet.",
    ].join("\n");
  }

  if (/lead|enquir|inquir|pipeline|prospect/.test(t)) {
    if (!s.leads) return `The leads pipeline isn't part of your access.`;
    return (
      `**${s.leads.open}** leads open${s.leads.overdue ? `, **${s.leads.overdue}** overdue a follow-up` : " and none overdue"}. ` +
      `**${s.leads.won_this_month}** won this month, worth ${money(s.leads.won_value)} a month.`
    );
  }
  return null;
}

function snapshotAsText(s: Snapshot): string {
  const c = s.content;
  const lines = [
    `Scope: ${s.scope}. Month: ${s.month}.`,
    `Planned this month: ${c.month_planned}; approved: ${c.month_approved}; posted: ${c.posted_this_month}.`,
    `Due today: ${c.due_today}; overdue: ${c.overdue}.`,
    `Awaiting client approval: ${c.awaiting_client}; changes requested: ${c.changes_requested}.`,
    `Waiting for raw footage: ${c.waiting_for_raw}; in editing: ${c.in_editing}; scheduled: ${c.scheduled}; missed their post slot: ${c.not_posted}.`,
  ];
  if (s.clients) lines.push(`Clients: ${s.clients.active} active of ${s.clients.total}.`);
  if (s.money)
    lines.push(
      `Revenue received this month: ${s.money.received_this_month}; pending: ${s.money.pending}. (INR)`
    );
  if (s.by_client?.length)
    lines.push(
      `Per client (planned/approved): ${s.by_client.map((b) => `${b.client} ${b.planned}/${b.approved}`).join("; ")}.`
    );
  if (s.today_list?.length)
    lines.push(
      `Due or overdue now: ${s.today_list.map((r) => `"${r.title}" (${r.client}, ${r.status})`).join("; ")}.`
    );
  if (s.performance) {
    const p = s.performance;
    lines.push(
      `Published performance this month: ${p.posts} posts, ${p.reach} accounts reached, ` +
        `${p.interactions} interactions${p.rate === null ? "" : `, ${p.rate.toFixed(1)}% engagement rate`}.` +
        (p.followers === null ? "" : ` Followers ${p.followers}${p.follower_growth === null ? "" : `, ${p.follower_growth} gained this month`}.`) +
        (p.best_format ? ` Best format by average reach: ${p.best_format}.` : "") +
        (p.best_day ? ` Best day: ${p.best_day}.` : "")
    );
    if (p.top.length)
      lines.push(
        `Best posts this month: ${p.top
          .map((t) => `"${t.caption}" (${t.format}, ${t.reach} reach${t.rate === null ? "" : `, ${t.rate.toFixed(1)}%`})`)
          .join("; ")}.`
      );
  }
  if (s.leads)
    lines.push(
      `Leads pipeline: ${s.leads.open} open, ${s.leads.overdue} overdue a follow-up, ` +
        `${s.leads.won_this_month} won this month worth ${s.leads.won_value} per month. (INR)`
    );
  return lines.join("\n");
}

async function askGemini(question: string, s: Snapshot): Promise<string | null> {
  if (!env.gemini.enabled) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent?key=${env.gemini.apiKey}`;

  const system = [
    "You are the assistant inside a digital-marketing agency portal.",
    "Answer ONLY from the DATA block. It is already filtered to what this user may see.",
    "If the answer isn't in the DATA, say you don't have that information — never guess a number.",
    "Be brief: two or three sentences, or a short list. Use **bold** for figures.",
    "Never mention the DATA block, prompts, or that you are a language model.",
  ].join(" ");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: `DATA:\n${snapshotAsText(s)}\n\nQUESTION: ${question}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: { text?: string }) => p.text || "")
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function answerQuestion(user: SessionUser, question: string): Promise<string> {
  const q = question.trim();
  if (!q) return "Ask me about your content, approvals or workload.";

  const snap = await buildSnapshot(user);

  // Counts are answered from the data directly; only open questions reach the model.
  const fast = fastAnswer(q, snap);
  if (fast) return fast;

  const ai = await askGemini(q, snap);
  if (ai) return ai;

  const c = snap.content;
  return [
    `Here's where things stand across ${snap.scope}:`,
    `- **${c.month_planned}** planned this month, **${c.month_approved}** approved`,
    `- **${c.due_today}** due today, **${c.overdue}** overdue`,
    `- **${c.awaiting_client}** awaiting client approval, **${c.changes_requested}** with changes requested`,
  ].join("\n");
}

/** The chips shown under the greeting, tailored to what the role can act on. */
export function suggestionsFor(role: SessionUser["role"]): string[] {
  if (role === "poster_designer" || role === "video_editor") {
    return ["What's due today?", "How many are overdue?", "What's waiting on the client?"];
  }
  if (role === "crm") {
    return [
      "No. of videos planned this month",
      "What's due today?",
      "Pending approvals",
      "How did this month perform?",
      "Any leads overdue?",
    ];
  }
  return [
    "No. of videos planned this month",
    "What's due today?",
    "Pending approvals",
    "How did this month perform?",
    "What should we post next?",
    "Revenue this month",
    "Any leads overdue?",
  ];
}

/* ------------------------------- Charts ------------------------------- */

export type ChartSlice = { label: string; value: number };
export type AssistantChart =
  | { kind: "pie"; title: string; slices: ChartSlice[] }
  | { kind: "bar"; title: string; slices: ChartSlice[] };

/** Where the month's work currently sits — the pipeline at a glance. */
export function pipelineChart(s: Snapshot): AssistantChart {
  const c = s.content;
  return {
    kind: "pie",
    title: "Where this month's work sits",
    slices: [
      { label: "Waiting for raw", value: c.waiting_for_raw },
      { label: "In editing", value: c.in_editing },
      { label: "With client", value: c.awaiting_client },
      { label: "Changes asked", value: c.changes_requested },
      { label: "Scheduled", value: c.scheduled },
      { label: "Posted", value: c.posted_this_month },
    ].filter((x) => x.value > 0),
  };
}

/** Planned vs approved per client — only meaningful when there's more than one. */
export function clientChart(s: Snapshot): AssistantChart | null {
  if (!s.by_client?.length) return null;
  return {
    kind: "bar",
    title: "Approved of planned, by client",
    slices: s.by_client.slice(0, 8).map((b) => ({
      label: `${b.client} (${b.approved}/${b.planned})`,
      value: b.planned ? Math.round((b.approved / b.planned) * 100) : 0,
    })),
  };
}

/** The month's best posts by reach — only drawn when the question is about results. */
export function performanceChart(s: Snapshot): AssistantChart | null {
  if (!s.performance?.top.length) return null;
  return {
    kind: "bar",
    title: "Reach, this month's best posts",
    slices: s.performance.top.map((t) => ({
      label: `${t.caption.slice(0, 40)} (${t.format})`,
      value: t.reach,
    })),
  };
}

export function chartsFor(question: string, s: Snapshot): AssistantChart[] {
  const t = question.toLowerCase();
  if (!/chart|graph|pie|breakdown|split|visual|progress/.test(t)) return [];

  // A question about results gets the results chart and stops there — the
  // pipeline pie is a true answer to a question nobody asked.
  if (/reach|engagement|perform|result|post/.test(t)) {
    const perf = performanceChart(s);
    if (perf) return [perf];
  }

  const out: AssistantChart[] = [];
  const pipe = pipelineChart(s);
  if (pipe.slices.length) out.push(pipe);
  const byClient = clientChart(s);
  if (byClient && byClient.slices.length) out.push(byClient);
  return out;
}

/* ------------------------------- Actions ------------------------------- */

export type ActionKind =
  | "request_approval"
  | "approval_reminder"
  | "footage_reminder"
  | "payment_reminder"
  | "send_month_plan"
  | "post_now"
  | "assign"
  | "message_client";

export type ActionOffer = {
  kind: ActionKind;
  label: string;
  /** Free-text prompt shown when the action needs something typed. */
  needsText?: string;
  targets: { id: number; label: string; sub?: string }[];
};

const CAN: Record<ActionKind, SessionUser["role"][]> = {
  // Sending work to the client stays where it already sits in the portal.
  request_approval: ["super_admin", "crm"],
  // Chasing a decision the client already has in front of them — same people
  // who were allowed to put it there.
  approval_reminder: ["super_admin", "crm"],
  // Asking for footage is chasing the client too, and the people who chase
  // them are the ones who talk to them.
  footage_reminder: ["super_admin", "crm"],
  payment_reminder: ["super_admin", "admin"],
  send_month_plan: ["super_admin", "crm"],
  /*
   * The one irreversible action here.
   *
   * It puts a video on a client's public Instagram account the moment it is
   * confirmed, and nothing in the portal can take it back. Super admin only,
   * matching the Post now button on the task page.
   */
  post_now: ["super_admin"],
  assign: ["super_admin", "admin", "crm"],
  message_client: ["super_admin", "admin", "crm"],
};

export const canRun = (role: SessionUser["role"], kind: ActionKind) => CAN[kind].includes(role);

/**
 * What this user could usefully do right now, given their role and their data.
 * These are only ever *offers* — each one still has to be confirmed before
 * anything is sent, because most of them reach a client.
 */
export async function actionOffers(user: SessionUser, question: string): Promise<ActionOffer[]> {
  const t = question.toLowerCase();
  const { where } = await scopeFor(user);
  const offers: ActionOffer[] = [];

  /*
   * What the person asked for, matched on words rather than word order.
   *
   * The old patterns assumed English sentence shape — "send to client" — and
   * so missed "client ki content share cheyi", which is how the request is
   * actually made here. A command the assistant silently declines to
   * understand is worse than one it cannot do, because there is nothing to
   * see: no offer appears and no reason is given.
   *
   * Each list is the action's own vocabulary, in both languages, matched
   * anywhere in the sentence. Overlap between them is fine — two offers are
   * two buttons, and the person picks. Firing on nothing is the failure.
   */
  const wants = (re: RegExp) => re.test(t);

  if (canRun(user.role, "request_approval") && wants(/approv|review|ready|\b(send|share|pampu|forward)\b/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, c.company_name FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where}
          AND d.status IN ('caption_ready','editing','raw_uploaded')
        ORDER BY d.due_date IS NULL, d.due_date ASC LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "request_approval",
        label: "Send to the client for approval",
        targets: rows.map((r) => ({ id: n(r.id), label: String(r.title), sub: String(r.company_name) })),
      });
  }

  /*
   * Chasing a decision the client already has.
   *
   * Distinct from "send it to them" and easy to conflate: one puts a video in
   * front of a client, the other asks about one already sitting there. Offered
   * only for work actually waiting at a gate, so the two lists never overlap
   * and picking the wrong one is not possible.
   */
  if (canRun(user.role, "approval_reminder") && wants(/remind|chase|follow.?up|approv|waiting|reply|gurthu|nudge/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, c.company_name FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where}
          AND d.status IN ('content_review','review')
        ORDER BY d.due_date IS NULL, d.due_date ASC LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "approval_reminder",
        label: "Remind the client to approve it",
        targets: rows.map((r) => ({ id: n(r.id), label: String(r.title), sub: String(r.company_name) })),
      });
  }

  /* Raw footage the client still owes us. */
  if (canRun(user.role, "footage_reminder") && wants(/footage|raw|shoot|clips|rushes|\bfiles?\b/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT DISTINCT c.id, c.company_name,
              COUNT(*) OVER (PARTITION BY c.id) AS waiting
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where}
          AND d.status IN ('pending','waiting_for_raw')
          AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')
          AND ${needsRawFootageSql("d")}
        ORDER BY c.company_name LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "footage_reminder",
        label: "Ask the client for their footage",
        targets: rows.map((r) => ({
          id: n(r.id),
          label: String(r.company_name),
          sub: `${n(r.waiting)} waiting on footage`,
        })),
      });
  }

  /* This month's schedule, as the client sees it. */
  if (canRun(user.role, "send_month_plan") && wants(/plan|schedule|calendar|this month|month.?s work/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT c.id, c.company_name, COUNT(d.id) AS n
         FROM clients c JOIN deliverables d ON d.client_id = c.id
        WHERE c.status <> 'churned' AND ${where}
          AND d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')
          AND d.status NOT IN ('cancelled','rejected')
        GROUP BY c.id, c.company_name ORDER BY c.company_name LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "send_month_plan",
        label: "Send them this month's plan",
        targets: rows.map((r) => ({
          id: n(r.id),
          label: String(r.company_name),
          sub: `${n(r.n)} pieces this month`,
        })),
      });
  }

  /*
   * Publish now, for work that is genuinely ready.
   *
   * Offered only for approved videos that are not already live, so the list
   * cannot include something still being edited or awaiting a decision. The
   * confirmation step in the widget is what stands between this and a client's
   * feed.
   */
  if (canRun(user.role, "post_now") && wants(/post|publish|go live|instagram|upload.*insta/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, c.company_name
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where}
          AND d.status IN ('approved','scheduled')
          AND COALESCE(d.instagram_status,'') <> 'posted'
          AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''
        ORDER BY d.scheduled_at IS NULL, d.scheduled_at ASC LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "post_now",
        label: "Post it to Instagram now",
        targets: rows.map((r) => ({ id: n(r.id), label: String(r.title), sub: String(r.company_name) })),
      });
  }

  if (canRun(user.role, "assign") && wants(/assign|who.*work|unassigned|team/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, c.company_name FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE c.status <> 'churned' AND ${where} AND d.assigned_to IS NULL
          AND d.status NOT IN ('posted','completed','cancelled','rejected')
        ORDER BY d.due_date IS NULL, d.due_date ASC LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "assign",
        label: "Assign to a team member",
        targets: rows.map((r) => ({ id: n(r.id), label: String(r.title), sub: String(r.company_name) })),
      });
  }

  if (canRun(user.role, "payment_reminder") && wants(/payment|invoice|unpaid|bill|money|\b(due|pay|paid)\b/)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT i.id, i.invoice_no, i.total, c.company_name
         FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE i.status <> 'paid' AND c.status <> 'churned'
        ORDER BY i.due_date IS NULL, i.due_date ASC LIMIT 8`
    );
    if (rows.length)
      offers.push({
        kind: "payment_reminder",
        label: "Send a payment reminder",
        targets: rows.map((r) => ({
          id: n(r.id),
          label: `${r.invoice_no} — ${money(n(r.total))}`,
          sub: String(r.company_name),
        })),
      });
  }

  if (canRun(user.role, "message_client") && wants(/message|tell|email|contact|talk|inform|update|\b(msg|cheppu)\b/)) {
    const ids = user.role === "crm" ? await crmClientIds(user) : null;
    const scope = ids && ids.length ? `AND id IN (${ids.map((v) => Math.trunc(Number(v))).join(",")})` : ids ? "AND 1=0" : "";
    const rows = await query<Record<string, unknown>>(
      `SELECT id, company_name, email FROM clients
        WHERE status <> 'churned' AND email IS NOT NULL AND email <> '' ${scope}
        ORDER BY company_name LIMIT 10`
    );
    if (rows.length)
      offers.push({
        kind: "message_client",
        label: "Send the client a message",
        needsText: "What should I say?",
        targets: rows.map((r) => ({ id: n(r.id), label: String(r.company_name), sub: String(r.email) })),
      });
  }

  return offers;
}
