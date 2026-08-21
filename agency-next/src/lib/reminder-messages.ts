/**
 * What a reminder actually says, and how it is worked out.
 *
 * One module, used by both senders. The nightly rules in
 * `whatsapp-reminders.ts` send these on a schedule; the console in
 * Settings → Reminders sends the same ones by hand. Two copies of this wording
 * would drift apart the first week either was edited, and a client would then
 * get a differently-worded chase depending on who or what sent it.
 *
 * Split in two halves on purpose:
 *
 *   - the `*Text` functions are pure. Given the facts, they return the words.
 *     Nothing to mock, so what a client will read is testable directly.
 *   - the `composeFor*` functions ask the database what is outstanding and
 *     hand it to those.
 *
 * The two senders scope differently and that is correct. The nightly footage
 * rule fires on the one day a shoot is three days out; a super admin pressing
 * the button means "everything you are still waiting on from them, now".
 */
import "server-only";
import { query } from "./db";
import { needsRawFootageSql } from "./raw-footage";
import { fmtDate, money } from "./utils";
import { paymentLinkForInvoice } from "./payment-links";

/** How many items a message lists before it summarises the rest. */
const MAX_LISTED = 8;

export type ReminderKind =
  | "footage_due"
  | "approval_chase"
  | "monthly_plan"
  | "invoice_due"
  | "team_digest"
  | "how_to_ask"
  | "custom";

/** The reminders a super admin can send by hand, in the order they're offered. */
export const SENDABLE: {
  kind: ReminderKind;
  label: string;
  blurb: string;
  /** False for the ones that go to the agency's own group, not a client's. */
  perClient: boolean;
}[] = [
  {
    kind: "footage_due",
    label: "Send us your footage",
    blurb: "Everything we're still waiting on raw footage for, and how to send it.",
    perClient: true,
  },
  {
    kind: "approval_chase",
    label: "Waiting on your approval",
    blurb: "Videos sitting with the client, unanswered.",
    perClient: true,
  },
  {
    kind: "monthly_plan",
    label: "This month's plan",
    blurb: "Everything scheduled this month, with the dates it goes out.",
    perClient: true,
  },
  {
    kind: "invoice_due",
    label: "Payment reminder",
    blurb: "Unpaid invoices, with a link they can pay from the group.",
    perClient: true,
  },
  {
    kind: "team_digest",
    label: "Today's work (team)",
    blurb: "What the team owes today. Goes to the agency's own group.",
    perClient: false,
  },
  {
    kind: "how_to_ask",
    label: "What you can ask us",
    blurb: "Teaches the group what to type — approvals, footage, and just asking a question.",
    perClient: true,
  },
  {
    kind: "custom",
    label: "Something else",
    blurb: "Your own message, sent now or at a time you pick.",
    perClient: true,
  },
];

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

const andMore = (total: number, listed: number) =>
  total > listed ? `\n…and ${total - listed} more.` : "";

export type FootageItem = { title: string; due_date: string | null };

/**
 * Asking for raw footage.
 *
 * When everything shares one date the message leads with it, because that date
 * is the reason for the message. When the dates differ — which is what a
 * manual "chase them for everything" send usually finds — each line carries
 * its own, and leading with any single one would be a false deadline.
 */
/**
 * Which time of asking this is.
 *
 * The same words three times is what makes a chase easy to stop reading. Each
 * one says something the last did not — a few days' warning, then the day
 * itself, then the fact that the date has gone by — while staying a request
 * rather than turning into a complaint. The third is the one worth watching:
 * it is the one that would read as blame if it were written carelessly, so it
 * offers to hold the slot rather than pointing out that the client is late.
 */
export type FootageStage = "early" | "due" | "late";

export function footageText(items: FootageItem[], stage: FootageStage = "early"): string {
  const listed = items.slice(0, MAX_LISTED);
  const dates = new Set(items.map((i) => i.due_date || ""));
  const oneDate = dates.size === 1 && Boolean(items[0]?.due_date);
  const n = items.length;
  const these = n === 1 ? "This one" : `These ${n}`;

  const head = !oneDate
    ? `Hello! Whenever you have a moment, could you please send us the footage for ${n === 1 ? "this" : `these ${n}`}:`
    : stage === "due"
      ? `Hello! We're due to start editing *today* and we're still waiting on your footage.\n\n${these}:`
      : stage === "late"
        ? `Hello! Just coming back to this one — we were due to start editing on ` +
          `*${fmtDate(items[0].due_date)}*, and the footage hasn't reached us yet. ` +
          `We're holding the slot for you.\n\n${these}:`
        : `Hello! We're due to start editing on *${fmtDate(items[0].due_date)}*, and we're still waiting on your footage.\n\n${these}:`;

  const lines = listed
    .map((i) => (oneDate ? `• ${i.title}` : `• ${i.title}${i.due_date ? ` — ${fmtDate(i.due_date)}` : ""}`))
    .join("\n");

  return (
    `${head}\n${lines}${andMore(n, listed.length)}\n\n` +
    `Please just reply with the link — a Drive or WeTransfer link on its own is enough, ` +
    `or write *raw* in front of any other link.\n\nThank you! 🙏`
  );
}

export type WaitingItem = { title: string; video_code: string | null };

/**
 * Chasing an approval.
 *
 * One video and several read differently, and it isn't only tone. A bare "OK"
 * is unambiguous when one thing is waiting and genuinely ambiguous when three
 * are — the approval parser refuses it, rightly. So the many-case names the
 * codes and asks for them.
 */
export function approvalChaseText(items: WaitingItem[]): string {
  if (items.length === 1) {
    return (
      `Just a gentle reminder — *${items[0].title}* is still waiting for your approval.\n\n` +
      `Whenever you're free, please reply *OK* to approve, or *change* followed by what you'd like different. ` +
      `A voice note works too.\n\nThank you! 🙏`
    );
  }

  const listed = items.slice(0, MAX_LISTED);
  const lines = listed
    .map((i) => (i.video_code ? `• *${i.video_code}* — ${i.title}` : `• ${i.title}`))
    .join("\n");
  const example = listed.find((i) => i.video_code)?.video_code;

  return (
    `A gentle reminder — ${items.length} are still waiting for your approval:\n\n` +
    `${lines}${andMore(items.length, listed.length)}\n\n` +
    (example
      ? `Whenever you're free, please reply *OK ${example}* to approve one, or *change ${example}* followed by what you'd like different. ` +
        `A voice note works too.`
      : `Whenever you're free, please reply *OK* against the one you mean, or *change* followed by what you'd like different.`) +
    `\n\nThank you! 🙏`
  );
}

export type PlanItem = { title: string; due_date: string | null };

export function monthlyPlanText(items: PlanItem[]): string {
  const listed = items.slice(0, 40);
  const lines = listed
    .map((i) => `• ${i.due_date ? fmtDate(i.due_date) : "TBC"} — ${i.title}`)
    .join("\n");
  return (
    `Hello! Here's *this month's plan* — ${items.length} piece${items.length === 1 ? "" : "s"} of content:\n\n` +
    `${lines}${andMore(items.length, listed.length)}\n\n` +
    `We'll send each one here for your approval before it goes out. ` +
    `Do let us know if you'd like anything changed — we're happy to adjust. 🙏`
  );
}

export type InvoiceItem = {
  invoice_no: string;
  total: number;
  due_date: string | null;
  /** Where they pay. A Razorpay link when there is one, the portal otherwise. */
  payUrl: string;
  payable: boolean;
  /** The invoice itself, as a document they can save or hand to an accountant. */
  docUrl?: string | null;
};

/**
 * Asking to be paid.
 *
 * The link is the message. "You can pay it in your portal" asks someone to
 * remember a password to give us money, and the friction is ours to remove —
 * so when Razorpay is configured this is a URL that opens straight into a
 * payment. The wording changes with it: pointing at a portal and pointing at a
 * checkout are different requests and shouldn't read the same.
 */
export function invoiceText(items: InvoiceItem[]): string {
  if (items.length === 1) {
    const i = items[0];
    const due = i.due_date ? `, which was due ${fmtDate(i.due_date)}` : "";
    return (
      `Hello! Just a gentle reminder about invoice *${i.invoice_no}* for *${money(i.total)}*${due}.\n\n` +
      (i.payable
        ? `Whenever convenient, you can pay it here — it opens straight into UPI, card or net banking:\n${i.payUrl}`
        : `Whenever convenient, you can view and pay it in your portal:\n${i.payUrl}`) +
      // The paying and the paperwork are two different needs: the person who
      // taps the link is rarely the one who files the invoice.
      (i.docUrl ? `\n\n📄 The invoice itself, to save or print:\n${i.docUrl}` : "") +
      `\n\nIf anything looks wrong, please do let us know and we'll sort it out. Thank you! 🙏`
    );
  }

  const total = items.reduce((sum, i) => sum + Number(i.total || 0), 0);
  const lines = items
    .slice(0, MAX_LISTED)
    .map(
      (i) =>
        `• *${i.invoice_no}* — ${money(i.total)}${i.due_date ? `, due ${fmtDate(i.due_date)}` : ""}\n  ${i.payUrl}`
    )
    .join("\n");
  return (
    `Hello! Just a gentle reminder about ${items.length} unpaid invoices, *${money(total)}* in total:\n\n` +
    `${lines}${andMore(items.length, Math.min(items.length, MAX_LISTED))}\n\n` +
    `If anything looks wrong, please do let us know and we'll sort it out. Thank you! 🙏`
  );
}

/**
 * The message that teaches a group what it can say to us.
 *
 * Every other message here is sent because something is outstanding. This one
 * is sent once, when a group is quiet and nobody is being chased, and its
 * whole job is to turn a group people only reply in into one they ask in.
 *
 * Grouped by what the client wants rather than by how the portal works —
 * "approve a video", "send footage", "just ask" — because a client does not
 * know or care which of those is a keyword and which is the assistant reading
 * their record. Both work; only one of them needs the exact word, and that is
 * the only distinction worth putting in front of them.
 *
 * The command words here must stay identical to the parser's. A client
 * following our own instructions and being told they typed it wrong is the
 * worst outcome this message could have.
 */
export function howToAskText(companyName?: string | null): string {
  return [
    companyName ? `Hello ${companyName}! 👋` : "Hello! 👋",
    "",
    "A quick note on what you can send us here — anything at all, any time.",
    "",
    "*When we send you a video*",
    "✅ *OK* — approve it",
    "📝 *CHANGE* — then tell us what you'd like different",
    "_A voice note works too._",
    "",
    "*To send us footage*",
    "Just paste the link. A Drive or WeTransfer link on its own is enough — for any other link, write *raw* in front of it.",
    "",
    "*To see where everything stands*",
    "Type *status* and we'll send this month's progress.",
    "",
    "*Or simply ask*",
    "No special words needed. For example:",
    "• _When is my next video going out?_",
    "• _How many videos do I get this month?_",
    "• _Is anything waiting on me?_",
    "• _What do I owe?_",
    "",
    "You can write in English, Telugu or Hindi — whichever you prefer. If it's something we need to check, we'll say so and someone from our team will come back to you.",
    "",
    "Thank you! 🙏",
  ].join("\n");
}

export type DigestItem = { company_name: string; title: string; due_date: string | null };

export function teamDigestText(items: DigestItem[], awaiting: number, today: string): string {
  const overdue = items.filter((r) => r.due_date && r.due_date < today).length;
  const listed = items.slice(0, 25);
  const lines = listed.map((r) => `• ${r.company_name} — ${r.title}`).join("\n");
  return (
    `*Today* — ${items.length} due or overdue${overdue ? ` (${overdue} late)` : ""}, ` +
    `${awaiting} waiting on clients.\n\n${lines}${andMore(items.length, listed.length)}`
  );
}

/* ------------------------------------------------------------------ *
 * What is outstanding, for a message sent by hand
 * ------------------------------------------------------------------ */

export type Composed = {
  text: string | null;
  /** Why there is nothing to send, when there isn't. Shown as-is. */
  nothing?: string;
  /** A link we wanted to make and couldn't — the message still goes. */
  warning?: string;
};

async function composeFootage(clientId: number): Promise<Composed> {
  const rows = await query<FootageItem>(
    `SELECT title, due_date FROM deliverables
      WHERE client_id = ? AND status IN ('pending','waiting_for_raw')
        AND (raw_drive_link IS NULL OR raw_drive_link = '')
        AND ${needsRawFootageSql("")}
      ORDER BY due_date IS NULL, due_date ASC, id ASC LIMIT 40`,
    [clientId]
  );
  if (rows.length === 0)
    return { text: null, nothing: "Nothing is waiting on footage from this client." };
  return { text: footageText(rows) };
}

async function composeApprovalChase(clientId: number): Promise<Composed> {
  const rows = await query<WaitingItem>(
    `SELECT title, video_code FROM deliverables
      WHERE client_id = ? AND status IN ('content_review','review')
      ORDER BY due_date IS NULL, due_date ASC, id ASC LIMIT 40`,
    [clientId]
  );
  if (rows.length === 0)
    return { text: null, nothing: "Nothing is sitting with this client for approval." };
  return { text: approvalChaseText(rows) };
}

async function composeMonthlyPlan(clientId: number, month: string): Promise<Composed> {
  const rows = await query<PlanItem>(
    `SELECT title, COALESCE(scheduled_at, due_date) AS due_date
       FROM deliverables
      WHERE client_id = ? AND month_key = ? AND status NOT IN ('cancelled','rejected')
      ORDER BY due_date IS NULL, due_date ASC LIMIT 40`,
    [clientId, month]
  );
  if (rows.length === 0)
    return { text: null, nothing: `Nothing is planned for this client in ${month}.` };
  return { text: monthlyPlanText(rows) };
}

/**
 * Unpaid invoices, each with somewhere to pay it.
 *
 * Unlike the nightly rule this does not require the due date to have passed —
 * a super admin sending this by hand has a reason, and refusing because the
 * invoice is due on Friday would just mean they type it out themselves.
 */
async function composeInvoices(clientId: number): Promise<Composed> {
  const rows = await query<{
    id: number;
    invoice_no: string;
    total: number;
    due_date: string | null;
  }>(
    `SELECT id, invoice_no, total, due_date FROM invoices
      WHERE client_id = ? AND status IN ('sent','overdue','partial')
      ORDER BY due_date IS NULL, due_date ASC, id ASC LIMIT 10`,
    [clientId]
  );
  if (rows.length === 0) return { text: null, nothing: "This client has no unpaid invoices." };

  const items: InvoiceItem[] = [];
  let warning: string | undefined;
  for (const r of rows) {
    const link = await paymentLinkForInvoice(r.id);
    // Reported once. Five invoices failing for the same reason is one problem
    // with the Razorpay account, not five.
    if (link.warning && !warning) warning = link.warning;
    items.push({
      invoice_no: r.invoice_no,
      total: Number(r.total) || 0,
      due_date: r.due_date,
      payUrl: link.url,
      payable: link.payable,
    });
  }
  return { text: invoiceText(items), warning };
}

async function composeTeamDigest(): Promise<Composed> {
  const rows = await query<DigestItem>(
    `SELECT c.company_name, d.title, d.due_date
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.due_date <= CURDATE()
        AND d.status NOT IN ('posted','completed','cancelled','rejected')
      ORDER BY d.due_date ASC LIMIT 25`
  );
  if (rows.length === 0) return { text: null, nothing: "Nothing is due or overdue today." };

  const [awaiting] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.status IN ('content_review','review')`
  );
  const today = new Date().toISOString().slice(0, 10);
  return { text: teamDigestText(rows, Number(awaiting?.n) || 0, today) };
}

/**
 * The message this reminder would send to this client right now.
 *
 * Returns `text: null` with a reason rather than an empty string, so the
 * console can say "nothing is waiting on footage" instead of offering a blank
 * message to send.
 */
export async function composeReminder(
  kind: ReminderKind,
  clientId: number | null,
  opts: { month?: string } = {}
): Promise<Composed> {
  const month = opts.month || new Date().toISOString().slice(0, 7);
  if (kind === "team_digest") return composeTeamDigest();
  if (kind === "custom") return { text: null, nothing: "Write the message yourself." };
  if (!clientId) return { text: null, nothing: "Pick a client first." };

  switch (kind) {
    case "how_to_ask": {
      // Nothing to look up — it is the same message whatever is outstanding.
      // The client's name is the only thing it needs from the database.
      const [c] = await query<{ company_name: string }>(
        "SELECT company_name FROM clients WHERE id = ?",
        [clientId]
      );
      return { text: howToAskText(c?.company_name ?? null) };
    }
    case "footage_due":
      return composeFootage(clientId);
    case "approval_chase":
      return composeApprovalChase(clientId);
    case "monthly_plan":
      return composeMonthlyPlan(clientId, month);
    case "invoice_due":
      return composeInvoices(clientId);
    default:
      return { text: null, nothing: "Unknown reminder." };
  }
}
