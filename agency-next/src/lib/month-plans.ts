/**
 * What a client owes in one particular month.
 *
 * The client record carries `monthly_deliverables`, `monthly_posters` and
 * `package_amount` — one set of numbers, standing for every month there will
 * ever be. That is right for a client on the same retainer month after month
 * and wrong the first time one is not: "next month we want twelve videos
 * instead of eight and two extra posters" had nowhere to be written down
 * except by editing the contract, which then reports the new numbers for
 * *this* month too, and for every month already in the past.
 *
 * So a month may have its own plan. When it does, that is what the month means
 * — the targets the generator fills to, the numbers the progress bars read,
 * and the amount billed. When it does not, the contract answers exactly as
 * before, so a client who never needs this never sees it.
 *
 * ## Written by hand, on purpose
 *
 * There is no rate table and nothing is calculated. Counts and amount are
 * three numbers somebody types, because what a month is worth is settled in a
 * conversation with the client and not by multiplication — a month with two
 * extra posters is not reliably a month costing two posters more.
 *
 * ## The table may not exist yet
 *
 * Every read is guarded. On a database that has not applied the migration the
 * contract answers, which is what the whole portal did before this existed.
 */
import "server-only";
import { query, queryOne, execute, hasTable } from "./db";

export type MonthPlanRow = {
  clientId: number;
  month: string;
  videos: number;
  posters: number;
  amount: number;
  note: string | null;
  /** The invoice this plan raised, if it has raised one. */
  invoiceId: number | null;
  invoiceNo: string | null;
};

/** `YYYY-MM`, or null when the input is not one. */
export function safeMonthKey(month: string): string | null {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

const TABLE = "client_month_plans";

/** The plan for one month, or null when that month follows the contract. */
export async function monthPlanFor(clientId: number, month: string): Promise<MonthPlanRow | null> {
  const mk = safeMonthKey(month);
  if (!mk) return null;
  if (!(await hasTable(TABLE))) return null;

  const row = await queryOne<{
    videos: number;
    posters: number;
    amount: string | number;
    note: string | null;
    invoice_id: number | null;
    invoice_no: string | null;
  }>(
    `SELECT p.videos, p.posters, p.amount, p.note, p.invoice_id, i.invoice_no
       FROM ${TABLE} p
       LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.client_id = ? AND p.month_key = ?`,
    [clientId, mk]
  ).catch(() => null);
  if (!row) return null;

  return {
    clientId,
    month: mk,
    videos: Math.max(0, Number(row.videos) || 0),
    posters: Math.max(0, Number(row.posters) || 0),
    amount: Number(row.amount) || 0,
    note: row.note,
    invoiceId: row.invoice_id ?? null,
    invoiceNo: row.invoice_no ?? null,
  };
}

/**
 * Every month this client has a plan for, soonest first.
 *
 * The point of the feature is the months that have not happened yet, so they
 * have to be visible without stepping to each one to find out whether it holds
 * anything.
 */
export async function plannedMonths(clientId: number, fromMonth: string): Promise<MonthPlanRow[]> {
  if (!(await hasTable(TABLE))) return [];
  const from = safeMonthKey(fromMonth) ?? "0000-00";

  const rows = await query<{
    month_key: string;
    videos: number;
    posters: number;
    amount: string | number;
    note: string | null;
    invoice_id: number | null;
    invoice_no: string | null;
  }>(
    `SELECT p.month_key, p.videos, p.posters, p.amount, p.note, p.invoice_id, i.invoice_no
       FROM ${TABLE} p
       LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.client_id = ? AND p.month_key >= ?
      ORDER BY p.month_key ASC
      LIMIT 24`,
    [clientId, from]
  ).catch(() => []);

  return rows.map((r) => ({
    clientId,
    month: r.month_key,
    videos: Math.max(0, Number(r.videos) || 0),
    posters: Math.max(0, Number(r.posters) || 0),
    amount: Number(r.amount) || 0,
    note: r.note,
    invoiceId: r.invoice_id ?? null,
    invoiceNo: r.invoice_no ?? null,
  }));
}

/**
 * Write one month's plan.
 *
 * `ON DUPLICATE KEY UPDATE` against the unique `(client_id, month_key)`, so
 * editing a month is the same call as creating it and pressing Save twice does
 * not leave two plans for one month disagreeing with each other.
 *
 * `invoice_id` is deliberately untouched here: raising the invoice is a
 * separate step with its own guard, and re-saving a month that has already
 * been billed must not silently forget that it was.
 */
export async function saveMonthPlan(input: {
  clientId: number;
  month: string;
  videos: number;
  posters: number;
  amount: number;
  note?: string | null;
  createdBy?: number | null;
}): Promise<boolean> {
  const mk = safeMonthKey(input.month);
  if (!mk || !input.clientId) return false;
  if (!(await hasTable(TABLE))) return false;

  const videos = Math.max(0, Math.trunc(Number(input.videos) || 0));
  const posters = Math.max(0, Math.trunc(Number(input.posters) || 0));
  const amount = Math.max(0, Math.round((Number(input.amount) || 0) * 100) / 100);

  await execute(
    `INSERT INTO ${TABLE} (client_id, month_key, videos, posters, amount, note, created_by)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       videos = VALUES(videos),
       posters = VALUES(posters),
       amount = VALUES(amount),
       note = VALUES(note)`,
    [input.clientId, mk, videos, posters, amount, input.note?.slice(0, 500) || null, input.createdBy ?? null]
  );
  return true;
}

/** Remove a month's plan, so it follows the contract again. */
export async function clearMonthPlan(clientId: number, month: string): Promise<boolean> {
  const mk = safeMonthKey(month);
  if (!mk) return false;
  if (!(await hasTable(TABLE))) return false;
  await execute(`DELETE FROM ${TABLE} WHERE client_id = ? AND month_key = ?`, [clientId, mk]);
  return true;
}

/**
 * Record which invoice a month's plan raised.
 *
 * Only ever sets it, and only when it is not already set — the return value
 * says whether this call was the one that claimed the month. That is what
 * makes billing idempotent: two saves, a double-click, or a retry after a
 * timeout can all reach the biller, and only the first is allowed to send an
 * invoice to a client.
 */
export async function claimMonthInvoice(
  clientId: number,
  month: string,
  invoiceId: number
): Promise<boolean> {
  const mk = safeMonthKey(month);
  if (!mk) return false;
  const res = await execute(
    `UPDATE ${TABLE} SET invoice_id = ?
      WHERE client_id = ? AND month_key = ? AND invoice_id IS NULL`,
    [invoiceId, clientId, mk]
  );
  return res.affectedRows === 1;
}
