/**
 * What the agency spends, and what is about to be owed.
 *
 * The portal has always known what comes in — invoices, payments, a client's
 * package. It knew nothing about what goes out, which makes every revenue
 * number on it half an answer: ₹4L billed in a month is a good month or a bad
 * one depending on a figure that lived in somebody's head.
 *
 * Two jobs, and the second is the one that earns its place. Recording a spend
 * is bookkeeping and any spreadsheet does it. Knowing that four subscriptions
 * and the salaries fall due next week, before they fall due, is the thing a
 * spreadsheet does not do — so a recurring expense carries its own next date
 * and says so on the board while there is still time to act.
 */
import "server-only";
import { query, queryOne } from "./db";
import type { ExpenseRow } from "./expense-kinds";

/*
 * The pure half lives in `expense-kinds.ts` so the ledger table — a client
 * component — can read a category label without pulling a server-only module
 * into the browser bundle. Re-exported so callers still have one import.
 */
export {
  EXPENSE_CATEGORIES,
  isCategory,
  categoryLabel,
  REPEATS,
  isRepeat,
  nextDue,
} from "./expense-kinds";
export type { ExpenseCategory, Repeat, ExpenseRow } from "./expense-kinds";

/* ------------------------------------------------------------------ */

export type ExpenseBoard = {
  /** Paid this calendar month, and the same figure for last month. */
  spentThisMonth: number;
  spentLastMonth: number;
  /** Received this month, from payments — so the two can be read together. */
  receivedThisMonth: number;
  /** Unpaid and past due. The number that costs money to ignore. */
  overdue: { count: number; total: number };
  /** Unpaid and due within the fortnight. */
  dueSoon: { count: number; total: number };
  /** What repeating expenses commit the agency to every month. */
  committedMonthly: number;
  byCategory: { category: string; total: number }[];
  rows: ExpenseRow[];
};

/**
 * Everything the board shows, in one round trip's worth of queries.
 *
 * Dates are compared in the database rather than in JavaScript throughout.
 * `CURDATE()` is the database's idea of today, and this server is not always
 * in the same day as it is — a due date decided here and a due date filtered
 * there would disagree for five and a half hours out of every twenty-four.
 */
export async function getExpenseBoard(): Promise<ExpenseBoard> {
  const [totals, received, categories, rows] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(CASE WHEN paid_on IS NOT NULL
                            AND DATE_FORMAT(paid_on,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')
                       THEN amount END),0) AS spent_this,
         COALESCE(SUM(CASE WHEN paid_on IS NOT NULL
                            AND DATE_FORMAT(paid_on,'%Y-%m') =
                                DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH,'%Y-%m')
                       THEN amount END),0) AS spent_last,
         COALESCE(SUM(CASE WHEN paid_on IS NULL AND due_on < CURDATE() THEN amount END),0) AS overdue_total,
         COALESCE(SUM(paid_on IS NULL AND due_on < CURDATE()),0) AS overdue_count,
         COALESCE(SUM(CASE WHEN paid_on IS NULL AND due_on BETWEEN CURDATE() AND CURDATE() + INTERVAL 14 DAY
                       THEN amount END),0) AS soon_total,
         COALESCE(SUM(paid_on IS NULL AND due_on BETWEEN CURDATE() AND CURDATE() + INTERVAL 14 DAY),0) AS soon_count,
         COALESCE(SUM(CASE repeats
                        WHEN 'monthly'   THEN amount
                        WHEN 'quarterly' THEN amount / 3
                        WHEN 'yearly'    THEN amount / 12
                      END),0) AS committed
       FROM expenses`
    ),
    queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payments
        WHERE status = 'paid'
          AND DATE_FORMAT(COALESCE(paid_at, created_at),'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')`
    ),
    query<{ category: string; total: number }>(
      `SELECT category, COALESCE(SUM(amount),0) AS total FROM expenses
        WHERE paid_on IS NOT NULL
          AND DATE_FORMAT(paid_on,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')
        GROUP BY category
        ORDER BY total DESC`
    ),
    /*
     * Unpaid first, oldest due date first — the board is a worklist before it
     * is a ledger, and a paid expense from three weeks ago is history.
     */
    query<ExpenseRow>(
      `SELECT e.id, e.title, e.category, e.amount, e.vendor, e.due_on, e.paid_on,
              e.repeats, e.remind, e.remind_days, e.client_id, e.note,
              c.company_name
         FROM expenses e
         LEFT JOIN clients c ON c.id = e.client_id
        ORDER BY e.paid_on IS NOT NULL, e.due_on ASC, e.id DESC
        LIMIT 200`
    ),
  ]);

  const n = (v: unknown) => Number(v ?? 0);
  return {
    spentThisMonth: n(totals?.spent_this),
    spentLastMonth: n(totals?.spent_last),
    receivedThisMonth: n(received?.total),
    overdue: { count: n(totals?.overdue_count), total: n(totals?.overdue_total) },
    dueSoon: { count: n(totals?.soon_count), total: n(totals?.soon_total) },
    committedMonthly: n(totals?.committed),
    byCategory: categories.map((c) => ({ category: c.category, total: n(c.total) })),
    rows: rows.map((r) => ({ ...r, amount: n(r.amount) })),
  };
}

/* ------------------------------------------------------------------ */

/**
 * Expenses due soon enough to be worth saying out loud.
 *
 * Each row carries its own notice period — a ₹2,000 subscription wants three
 * days and a quarter's GST wants a fortnight, and one number for both is
 * either noise or too late. `remind` off excludes a row entirely, which is
 * what makes the daily message readable enough to keep reading.
 */
export async function expensesNeedingNotice(): Promise<
  { id: number; title: string; amount: number; due_on: string; overdue: boolean }[]
> {
  const rows = await query<{ id: number; title: string; amount: number; due_on: string; overdue: number }>(
    `SELECT id, title, amount, due_on, due_on < CURDATE() AS overdue
       FROM expenses
      WHERE paid_on IS NULL
        AND remind = 1
        AND due_on <= CURDATE() + INTERVAL remind_days DAY
      ORDER BY due_on ASC`
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount), overdue: Number(r.overdue) === 1 }));
}
