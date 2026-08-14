/**
 * What the agency spends.
 *
 * The number that has to be right is the next due date. A recurring expense is
 * a chain of rows — paying one creates the following one — so an error there
 * does not show up as a wrong date on a screen, it compounds: every month the
 * subscription drifts a little further from the day it is actually billed,
 * until the reminder arrives after the money has already gone.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
// The pure half — categories, intervals, the rollover. The queries live in
// lib/expenses.ts, which is server-only and needs a database.
const ex = await import(pathToFileURL(`${SRC}/lib/expense-kinds.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- the next due date is a calendar month ---------------- */
{
  // Adding thirty days would drift: a subscription billed on the 31st would
  // walk backwards through the month a little further every time.
  assert.equal(ex.nextDue("2026-08-15", "monthly"), "2026-09-15");
  assert.equal(ex.nextDue("2026-08-15", "quarterly"), "2026-11-15");
  assert.equal(ex.nextDue("2026-08-15", "yearly"), "2027-08-15");
  assert.equal(ex.nextDue("2026-08-15", "once"), null, "a one-off does not come back");

  // Month ends, which is where the naive version breaks: JavaScript rolls the
  // 31st of February forward into March rather than clamping it.
  assert.equal(ex.nextDue("2026-01-31", "monthly"), "2026-02-28", "31 Jan lands on the 28th");
  assert.equal(ex.nextDue("2026-08-31", "monthly"), "2026-09-30", "31 Aug lands on the 30th");
  assert.equal(ex.nextDue("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(ex.nextDue("2024-02-29", "yearly"), "2025-02-28", "a leap day in a common year");
  assert.equal(ex.nextDue("2024-01-31", "monthly"), "2024-02-29", "and gets the 29th in a leap one");

  // Crossing the year.
  assert.equal(ex.nextDue("2026-12-15", "monthly"), "2027-01-15");
  assert.equal(ex.nextDue("2026-11-01", "quarterly"), "2027-02-01");

  assert.equal(ex.nextDue("", "monthly"), null, "and nonsense in gives nothing out");
  ok("a repeating expense lands on the same day of the month, every month");
}

/* ---------------- categories are a fixed list, on purpose ---------------- */
{
  // Free text would make comparing two months impossible: "Adobe" typed three
  // ways is three categories that each look small.
  assert.ok(ex.EXPENSE_CATEGORIES.length >= 6, "enough to be useful");
  assert.ok(ex.isCategory("salaries") && ex.isCategory("software") && ex.isCategory("ads"));
  assert.ok(!ex.isCategory("Adobe"), "and anything else is refused");
  assert.equal(ex.categoryLabel("salaries"), "Salaries & freelancers");
  assert.equal(ex.categoryLabel("nonsense"), "Other", "an unknown key still renders");

  assert.ok(ex.isRepeat("monthly") && ex.isRepeat("once"));
  assert.ok(!ex.isRepeat("fortnightly"), "only the four the rollover can compute");
  ok("categories and intervals are closed lists the board can compare on");
}

/* ---------------- dates are the database's, not this server's ---------------- */
{
  const lib =
    readFileSync(`${SRC}/lib/expenses.ts`, "utf8") +
    readFileSync(`${SRC}/lib/expense-kinds.ts`, "utf8");
  // The database clock is IST and the app writes UTC. A due date decided here
  // and filtered there disagrees for five and a half hours out of every day.
  // `new Date(Date.UTC(...))` is fine — that is arithmetic on a date it was
  // given. A bare `new Date()` would be this process deciding what today is.
  assert.ok(!/new Date\(\)/.test(lib), "no 'today' from this process");
  has(lib, "CURDATE()", "every comparison is made in SQL");

  const page = readFileSync(`${SRC}/app/(app)/expenses/page.tsx`, "utf8");
  has(page, "SELECT CURDATE() AS d", "and the page asks the database what today is");
  ok("today means the same thing on the board as in the query behind it");
}

/* ---------------- money in is shown beside money out ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/expenses.ts`, "utf8");
  // The point of the board. Spend on its own is bookkeeping; spend against
  // what clients actually paid is the month.
  has(lib, "FROM payments", "revenue is read for the same month");
  has(lib, "status = 'paid'", "and only what was actually received");

  const page = readFileSync(`${SRC}/app/(app)/expenses/page.tsx`, "utf8");
  has(page, "board.receivedThisMonth - board.spentThisMonth", "the two are subtracted");
  has(page, 'left >= 0 ? "emerald" : "rose"', "and a negative month looks like one");

  // Repeating costs spread to a monthly figure — the number that answers
  // "what does it cost to keep the lights on".
  has(lib, "WHEN 'quarterly' THEN amount / 3", "a quarterly cost counts as a third");
  has(lib, "WHEN 'yearly'    THEN amount / 12", "and a yearly one as a twelfth");
  ok("the board answers what is left, not only what was spent");
}

/* ---------------- reminders are per row, and internal ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/expenses.ts`, "utf8");
  // A ₹2,000 subscription wants three days' notice and a quarter's GST wants a
  // fortnight. One number for both is either noise or too late.
  has(lib, "due_on <= CURDATE() + INTERVAL remind_days DAY", "each row carries its own notice period");
  has(lib, "remind = 1", "and one switched off says nothing at all");
  has(lib, "paid_on IS NULL", "nothing already paid is chased");

  const rem = readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8");
  has(rem, "async function expenseNotice", "it runs with the daily reminders");
  // Nothing here leaves the building. It goes to the portal's own notification
  // list, so it works with no WhatsApp group linked and no phone connected.
  has(rem, "await notifyAdmins(", "delivered to the agency, not a client group");
  assert.ok(
    !/expenseNotice[\s\S]{0,900}sendTextToGroup/.test(rem),
    "and never into a client's chat"
  );
  has(rem, 'claim("expense_due"', "claimed like the rest, so it cannot say it twice");
  has(rem, 'if (!(await hasTable("expenses"))) return { sent: 0, failed: 0 };', "and skipped where the table is absent");
  ok("each expense is chased on its own notice period, to the agency alone");
}

/* ---------------- adding, paying and deleting ---------------- */
{
  const act = readFileSync(`${SRC}/app/(app)/expenses/actions.ts`, "utf8");

  // Money is an admin's business. A crm is scoped to their own clients, and
  // rent belongs to nobody's account.
  has(act, "const ROLES = ADMIN_ROLES;", "the board is admin-only");

  has(act, 'Number(s(fd, "amount").replace(/[^0-9.]/g, ""))', "₹12,000 pasted from an invoice parses");
  has(act, "amount <= 0", "and zero is refused");
  has(act, "/^\\d{4}-\\d{2}-\\d{2}$/.test(v)", "a date has to be a date");
  has(act, "Math.min(60, Math.max(0,", "an absurd notice period is clamped, not rejected");

  // Paying a recurring expense is what creates the next one — otherwise
  // somebody retypes the same subscription twelve times a year, and the month
  // they forget is the month the board stops being true.
  has(act, "const following = nextDue(e.due_on, e.repeats as Repeat);", "paying rolls it forward");
  has(act, "WHERE id = ? AND paid_on IS NULL", "and paying twice is not possible");

  // Deleting removes the instance, never the series.
  has(act, 'await execute("DELETE FROM expenses WHERE id = ?"', "delete is one row");
  const table = readFileSync(`${SRC}/app/(app)/expenses/expense-table.tsx`, "utf8");
  has(table, "Only this one — the others in the series stay.", "and says so before it does it");
  ok("adding, paying and deleting each do exactly one thing");
}

/* ---------------- and the page degrades before the migration ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/expenses/page.tsx`, "utf8");
  has(page, 'if (!(await hasTable("expenses")))', "a database without the table is handled");
  has(page, "Settings → Database", "and told what to do about it");

  const table = readFileSync(`${SRC}/app/(app)/expenses/expense-table.tsx`, "utf8");
  // The ledger is a client component; lib/expenses.ts is server-only. Reaching
  // it for a category label is a build failure, not a runtime one.
  has(table, 'from "@/lib/expense-kinds"', "the table reads the pure module");
  assert.ok(!table.includes('from "@/lib/expenses"'), "and never the server-only one");
  const kinds = readFileSync(`${SRC}/lib/expense-kinds.ts`, "utf8");
  assert.ok(!/^import "server-only";/m.test(kinds), "which stays importable from the browser");

  const nav = readFileSync(`${SRC}/components/admin/nav-config.ts`, "utf8");
  has(nav, 'label: "Expenses", href: "/expenses"', "the board has a nav entry");
  has(nav, "roles: ADMIN", "for admins");
  ok("switching it on is one click, and it says so rather than erroring");
}

/* ---------------- and correcting one already recorded ---------------- */
{
  const act = readFileSync(`${SRC}/app/(app)/expenses/actions.ts`, "utf8");

  has(act, "export async function updateExpenseAction", "an expense can be corrected");
  has(act, "const existing = await queryOne<", "against a row that still exists");

  // The same gauntlet as adding. A validator on one path and not the other is
  // how a zero-rupee expense gets in through the back door.
  const add = act.slice(act.indexOf("addExpenseAction"), act.indexOf("markExpensePaidAction"));
  const upd = act.slice(act.indexOf("export async function updateExpenseAction"));
  for (const rule of [
    "amount <= 0",
    "if (!isCategory(category))",
    "if (!isRepeat(repeats))",
    "Math.min(60, Math.max(0,",
  ]) {
    assert.ok(add.includes(rule), `adding checks ${rule}`);
    assert.ok(upd.includes(rule), `and so does correcting: ${rule}`);
  }

  // The trap this design avoids. Paying a repeating expense creates the next
  // one, so an un-pay here would leave an unpaid row AND the instance it had
  // already spawned — the same subscription twice, neither marked as real.
  assert.ok(!upd.includes('fd.get("paid_now")'), "the edit cannot un-pay a row");
  has(act, "existing.paid_on ? asDate(", "only the paid date is correctable");
  has(act, "?? existing.paid_on : null", "and omitting it leaves the stored value alone");

  const table = readFileSync(`${SRC}/app/(app)/expenses/expense-table.tsx`, "utf8");
  has(table, "{row?.paidOn ? (", "the paid-date field appears only on a paid row");
  has(table, "{editing ? null : (", "and the already-paid tick only when adding");

  // One row, never the series — the same rule delete follows.
  has(table, "Changes apply to this one only.", "the dialog says which rows it touches");
  ok("an expense can be corrected without disturbing what it already did");
}

/* ---------------- one dialog, two jobs ---------------- */
{
  const table = readFileSync(`${SRC}/app/(app)/expenses/expense-table.tsx`, "utf8");

  // A second component for the second job is two places for a field to be
  // added and one place for it to be forgotten.
  has(table, "function ExpenseDialog", "add and edit share the form");
  assert.ok(!/function AddExpense/.test(table), "there is no second copy of it");
  has(table, "? await updateExpenseAction", "and the row decides which action runs");

  // Ids are per row. Two dialogs sharing `exp-title` is a label pointing at
  // another row's field, which nobody notices.
  has(table, 'const uid = row ? `e${row.id}` : "new";', "field ids are unique per row");
  assert.ok(!/id="exp-/.test(table), "none are hard-coded any more");

  // Mounted per row rather than one shared dialog holding an id: Modal renders
  // nothing when closed, so the fields remount from this row every time.
  has(table, "<ExpenseDialog", "the dialog is mounted where the row is");
  has(table, 'defaultValue={row?.title ?? ""}', "and starts from that row");
  ok("adding and correcting are the same form, and cannot drift apart");
}

/* ---------------- the dialog fits the screen it opens on ---------------- */
{
  const table = readFileSync(`${SRC}/app/(app)/expenses/expense-table.tsx`, "utf8");
  const modal = readFileSync(`${SRC}/components/ui/modal.tsx`, "utf8");

  // Modal is a flex column capped at 90vh, and that applies to its own
  // children. A <form> dropped in between meant `flex-1 overflow-y-auto` and
  // `shrink-0` were landing on children of the form instead — so the body
  // never scrolled, the dialog grew past the viewport, and Save went off the
  // bottom of the screen where nobody could reach it.
  has(modal, "flex max-h-[90vh] w-full flex-col", "the shell caps and lays out its children");
  has(table, 'className="flex min-h-0 flex-1 flex-col"', "so the form is that column, not a wrapper");

  // min-h-0 is the other half: a flex child will not shrink below its content
  // without it, whatever the overflow says.
  has(table, 'className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6"', "the body scrolls");
  has(table, "flex shrink-0 items-center justify-end gap-2 border-t border-border p-4", "the footer stays put");

  const brief = readFileSync(`${SRC}/app/(app)/content/brief-row.tsx`, "utf8");
  has(brief, "min-h-0 flex-1", "and the other dialog is pinned the same way");
  ok("a long dialog scrolls its body instead of pushing the buttons off-screen");
}

await finish(pass);
