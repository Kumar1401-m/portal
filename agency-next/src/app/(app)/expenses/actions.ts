"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { execute, query, queryOne } from "@/lib/db";
import { isCategory, isRepeat, nextDue, type Repeat } from "@/lib/expense-kinds";

export type ExpenseState = { ok: boolean; error?: string; message?: string };

/**
 * What the agency spends is an admin's business and nobody else's.
 *
 * Not crm: a crm is scoped to their own clients, and this board has no client
 * on most of its rows — salaries and rent are not anybody's account.
 */
const ROLES = ADMIN_ROLES;

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** YYYY-MM-DD, or null. Anything else is a typo, not a date. */
const asDate = (v: string): string | null =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

export async function addExpenseAction(
  _prev: ExpenseState,
  fd: FormData
): Promise<ExpenseState> {
  const user = await requireUser(ROLES);

  const title = s(fd, "title");
  if (!title) return { ok: false, error: "Give it a name — what is the money for?" };

  /*
   * Parsed off the digits, so "₹12,000" and "12000" are the same amount.
   * People paste from an invoice.
   */
  const amount = Number(s(fd, "amount").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }

  const dueOn = asDate(s(fd, "due_on"));
  if (!dueOn) return { ok: false, error: "Pick the date it is due." };

  const category = s(fd, "category");
  const repeats = s(fd, "repeats");
  if (!isCategory(category)) return { ok: false, error: "Pick a category." };
  if (!isRepeat(repeats)) return { ok: false, error: "Pick how often it repeats." };

  // Ticked at the time of entry, because "I paid this last week" is how most
  // one-off expenses get recorded at all.
  const paidNow = fd.get("paid_now") ? dueOn : null;

  const clientRaw = Number(s(fd, "client_id"));
  const clientId = Number.isInteger(clientRaw) && clientRaw > 0 ? clientRaw : null;

  const remindDaysRaw = Number(s(fd, "remind_days"));
  // Clamped rather than rejected: a reminder 400 days out is a mistake, not a
  // reason to throw away everything else they typed.
  const remindDays = Math.min(60, Math.max(0, Number.isFinite(remindDaysRaw) ? remindDaysRaw : 3));

  await execute(
    `INSERT INTO expenses
       (title, category, amount, vendor, due_on, paid_on, repeats, remind, remind_days,
        client_id, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      title.slice(0, 200),
      category,
      amount,
      s(fd, "vendor").slice(0, 150) || null,
      dueOn,
      paidNow,
      repeats,
      fd.get("remind") ? 1 : 0,
      remindDays,
      clientId,
      s(fd, "note").slice(0, 2000) || null,
      user.id,
    ]
  );

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, message: paidNow ? "Recorded as paid." : "Added." };
}

/**
 * Paid — which for a repeating expense is also when the next one appears.
 *
 * The alternative is somebody re-typing the same subscription twelve times a
 * year, and the month they forget is the month the board stops being true.
 * The row that was paid keeps its date as a record of what happened; the new
 * one carries the same terms forward.
 */
export async function markExpensePaidAction(
  _prev: ExpenseState,
  fd: FormData
): Promise<ExpenseState> {
  await requireUser(ROLES);
  const id = Number(s(fd, "id"));
  if (!id) return { ok: false, error: "Missing expense." };

  const e = await queryOne<{
    id: number;
    title: string;
    category: string;
    amount: number;
    vendor: string | null;
    due_on: string;
    repeats: string;
    remind: number;
    remind_days: number;
    client_id: number | null;
    note: string | null;
  }>(
    `SELECT id, title, category, amount, vendor, due_on, repeats, remind, remind_days,
            client_id, note
       FROM expenses WHERE id = ? AND paid_on IS NULL`,
    [id]
  );
  if (!e) return { ok: false, error: "That one is already marked paid." };

  await execute("UPDATE expenses SET paid_on = CURDATE() WHERE id = ?", [id]);

  const following = nextDue(e.due_on, e.repeats as Repeat);
  if (following) {
    await execute(
      `INSERT INTO expenses
         (title, category, amount, vendor, due_on, repeats, remind, remind_days, client_id, note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        e.title,
        e.category,
        e.amount,
        e.vendor,
        following,
        e.repeats,
        e.remind,
        e.remind_days,
        e.client_id,
        e.note,
      ]
    );
  }

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return {
    ok: true,
    message: following ? `Paid. The next one is due ${following}.` : "Paid.",
  };
}

/**
 * Gone, and only ever this one.
 *
 * A repeating expense is a chain of rows rather than one row with a rule, so
 * deleting is unambiguous: it removes the instance in front of you and leaves
 * the history alone. Somebody clearing out last year would otherwise find
 * they had cancelled next month's rent as well.
 */
export async function deleteExpenseAction(
  _prev: ExpenseState,
  fd: FormData
): Promise<ExpenseState> {
  await requireUser(ROLES);
  const id = Number(s(fd, "id"));
  if (!id) return { ok: false, error: "Missing expense." };

  const rows = await query<{ id: number }>("SELECT id FROM expenses WHERE id = ?", [id]);
  if (rows.length === 0) return { ok: false, error: "It is already gone." };

  await execute("DELETE FROM expenses WHERE id = ?", [id]);
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, message: "Deleted." };
}
