/**
 * The agency's own numbers, for the person who owns it.
 *
 * Every other module here answers a question about a client. This one answers
 * questions about the business: which clients earn, which ones cost, where the
 * money goes, and who is about to leave.
 *
 * **Effort is counted in tasks, not in money, and that is said out loud.** The
 * portal does not record hours, so no true cost-per-client exists in it — and
 * a profitability figure built on an invented hourly rate would be the most
 * dangerous number in the whole system, because it looks exactly like an
 * accountant's. Tasks delivered is a real count the board already holds; the
 * ratio of fee to tasks is an honest proxy and is labelled as one everywhere
 * it appears.
 *
 * Arithmetic here, wording from the model, same as the Brain.
 */
import "server-only";
import { query, queryOne, hasTable } from "./db";
import { callJSON } from "./ai";
import { onTheFloor } from "./client-status";
import { healthBoard } from "./ai-insights";
import { thisMonthKey, shiftMonth } from "./date-range";

const n = (v: unknown) => Number(v ?? 0);

export type ClientEconomics = {
  clientId: number;
  client: string;
  /** The agreed monthly fee, as recorded on the client. */
  fee: number;
  /** Actually received this month. */
  received: number;
  /** Still outstanding, any age. */
  pending: number;
  /** Tasks delivered this month — the effort proxy. */
  delivered: number;
  /** Fee ÷ tasks delivered. Null when nothing was delivered. */
  perTask: number | null;
};

export type Money = {
  month: string;
  received: number;
  pending: number;
  /** Total expenses recorded for the month, if the ledger is in use. */
  spent: number | null;
  /** Expenses by category, largest first. */
  byCategory: { category: string; amount: number }[];
};

export type Advice = {
  money: Money;
  clients: ClientEconomics[];
  /** Worst health first — the ones at risk of leaving. */
  atRisk: { client: string; score: number; reasons: string[] }[];
  /** The narrated answer. Falls back to a plain summary with no model. */
  summary: string;
  narrated: boolean;
};

/**
 * What came in, what went out, and per client.
 *
 * Personal accounts are excluded from every figure: the agency's own page is
 * not a client and counting it makes both the revenue and the effort wrong.
 */
export async function economics(month = thisMonthKey()): Promise<{ money: Money; clients: ClientEconomics[] }> {
  const [pay, rows, spend] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid' AND DATE_FORMAT(paid_at,'%Y-%m') = ? THEN amount END),0) AS received,
         COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending
       FROM payments`,
      [month]
    ).catch(() => null),

    query<Record<string, unknown>>(
      `SELECT c.id, c.company_name, COALESCE(c.package_amount,0) AS fee,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.client_id = c.id AND p.status='paid'
                           AND DATE_FORMAT(p.paid_at,'%Y-%m') = ?),0) AS received,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.client_id = c.id AND p.status='pending'),0) AS pending,
              COALESCE((SELECT COUNT(*) FROM deliverables d
                         WHERE d.client_id = c.id AND d.month_key = ?
                           AND d.status IN ('posted','completed')),0) AS delivered
         FROM clients c
        WHERE ${onTheFloor()} AND COALESCE(c.is_personal,0) = 0
        ORDER BY c.company_name`,
      [month, month]
    ).catch(() => []),

    (async () => {
      if (!(await hasTable("expenses"))) return null;
      return query<Record<string, unknown>>(
        `SELECT category, COALESCE(SUM(amount),0) AS amount
           FROM expenses
          WHERE DATE_FORMAT(COALESCE(paid_on, due_on),'%Y-%m') = ?
          GROUP BY category ORDER BY amount DESC`,
        [month]
      ).catch(() => null);
    })(),
  ]);

  const byCategory = (spend ?? []).map((r) => ({
    category: String(r.category),
    amount: n(r.amount),
  }));

  return {
    money: {
      month,
      received: n(pay?.received),
      pending: n(pay?.pending),
      spent: spend === null ? null : byCategory.reduce((t, c) => t + c.amount, 0),
      byCategory,
    },
    clients: rows.map((r) => {
      const fee = n(r.fee);
      const delivered = n(r.delivered);
      return {
        clientId: n(r.id),
        client: String(r.company_name),
        fee,
        received: n(r.received),
        pending: n(r.pending),
        delivered,
        // The honest proxy: what the agency is paid per piece of work it
        // actually shipped. Null rather than the fee itself when nothing
        // shipped — dividing by zero would rank a client who got nothing as
        // infinitely profitable.
        perTask: delivered > 0 && fee > 0 ? Math.round(fee / delivered) : null,
      };
    }),
  };
}

const money = (v: number) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v);
  } catch {
    return `INR ${Math.round(v)}`;
  }
};

/** The plain answer, from the figures, when no model replies. */
function plain(money_: Money, clients: ClientEconomics[], atRisk: Advice["atRisk"]): string {
  const rated = clients.filter((c) => c.perTask !== null).sort((a, b) => (b.perTask ?? 0) - (a.perTask ?? 0));
  const lines = [
    `${money(money_.received)} received this month, ${money(money_.pending)} still outstanding` +
      (money_.spent === null ? "." : `, against ${money(money_.spent)} of recorded spend.`),
  ];
  if (rated.length) {
    lines.push(
      `Best fee per delivered task: ${rated[0].client} at ${money(rated[0].perTask ?? 0)}. ` +
        `Lowest: ${rated[rated.length - 1].client} at ${money(rated[rated.length - 1].perTask ?? 0)}.`
    );
  }
  if (atRisk.length) {
    lines.push(`At risk: ${atRisk.slice(0, 3).map((r) => `${r.client} (${r.score})`).join(", ")}.`);
  }
  return lines.join("\n\n");
}

/**
 * The month, read as a business rather than as a content plan.
 *
 * The model is given the computed figures and asked what an owner should do
 * about them. It cannot reach the database and every number it may quote is in
 * the block it is handed — same contract as the Marketing Brain.
 */
export async function advise(month = thisMonthKey()): Promise<Advice> {
  const [{ money: m, clients }, health, lastMonth] = await Promise.all([
    economics(month),
    healthBoard().catch(() => []),
    economics(shiftMonth(month, -1)).catch(() => null),
  ]);

  const atRisk = health
    .filter((h) => h.band !== "healthy")
    .slice(0, 6)
    .map((h) => ({ client: h.client, score: h.score, reasons: h.reasons.map((r) => r.label) }));

  const rated = clients.filter((c) => c.perTask !== null);
  const data = [
    `Month: ${month}.`,
    `Received: ${m.received}. Outstanding: ${m.pending}.` +
      (m.spent === null ? " Expense ledger not in use." : ` Recorded spend: ${m.spent}.`),
    lastMonth ? `Last month received: ${lastMonth.money.received}.` : "",
    m.byCategory.length
      ? `Spend by category: ${m.byCategory.map((c) => `${c.category} ${c.amount}`).join("; ")}.`
      : "",
    `Clients (fee / received / outstanding / tasks delivered / fee per delivered task):`,
    ...clients.map(
      (c) =>
        `- ${c.client}: ${c.fee} / ${c.received} / ${c.pending} / ${c.delivered} / ${c.perTask ?? "n/a"}`
    ),
    atRisk.length
      ? `Health scores below healthy: ${atRisk.map((r) => `${r.client} ${r.score} (${r.reasons.join(", ")})`).join("; ")}.`
      : "Every client scored healthy.",
    `All money is INR. "Tasks delivered" is a count of published work — the portal records no hours, so there is no true cost per client.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data: reply } = await callJSON(
    [
      "You advise the owner of a small digital-marketing agency, from their own portal's figures.",
      "Only the DATA block is real. Never invent a number, a margin or a cost.",
      "There are no hours recorded, so never state a profit margin — talk about fee per delivered task and call it what it is.",
      "Four or five sentences: what this month says, which clients deserve attention, and the single thing to do next.",
      "Use **bold** for figures. No preamble.",
      "Reply with JSON only.",
    ].join(" "),
    `DATA:\n${data}\n\nReply as JSON: {"answer": "<your advice>"}`
  ).catch(() => ({ data: null }));

  const text = typeof reply?.answer === "string" ? reply.answer.trim() : "";
  return {
    money: m,
    clients: rated.sort((a, b) => (b.perTask ?? 0) - (a.perTask ?? 0)),
    atRisk,
    summary: text || plain(m, clients, atRisk),
    narrated: Boolean(text),
  };
}
