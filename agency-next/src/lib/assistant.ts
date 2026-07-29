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
import { query, queryOne, hasColumn } from "./db";
import { env } from "./env";
import type { SessionUser } from "./auth";
import { crmClientIds } from "./crm";

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
  };
  money?: { received_this_month: number; pending: number };
  by_client?: { client: string; planned: number; approved: number }[];
  today_list?: { title: string; client: string; status: string; due: string | null }[];
};

const n = (v: unknown) => Number(v ?? 0);

/** What this user is allowed to see, expressed as SQL fragments. */
async function scopeFor(user: SessionUser) {
  if (user.role === "poster_designer") {
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

export async function buildSnapshot(user: SessionUser): Promise<Snapshot> {
  const { label, where } = await scopeFor(user);
  const month = new Date().toISOString().slice(0, 7);
  const isAdmin = user.role === "super_admin" || user.role === "admin";

  const cloudOk = await hasColumn("deliverables", "cloud_video_key");

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
           AND d.scheduled_at < NOW() - INTERVAL 30 MINUTE
           AND d.instagram_status <> 'posted') AS not_posted
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE c.status <> 'churned' AND ${where}`
  );

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
    },
  };

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

  // Per-client split: not meaningful for a designer's personal worklist.
  if (user.role !== "poster_designer") {
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
  if (role === "poster_designer") {
    return ["What's due today?", "How many are overdue?", "What's waiting on the client?"];
  }
  if (role === "crm") {
    return [
      "No. of videos planned this month",
      "What's due today?",
      "Pending approvals",
      "Revisions received",
    ];
  }
  return [
    "No. of videos planned this month",
    "What's due today?",
    "Pending approvals",
    "Revenue this month",
    "Anything not posted?",
  ];
}
