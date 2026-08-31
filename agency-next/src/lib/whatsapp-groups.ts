/**
 * What each of a client's WhatsApp groups is for.
 *
 * A client is often in more than one group with us, and the people who
 * approve the work are rarely the people who pay for it. Neither wants the
 * other's messages: an invoice chase in the group where the creative team
 * talks is embarrassing, and "your reel is live" in the accounts group is
 * noise. Until now every message the portal sent picked "the client's group"
 * the same way in six separate files — default first, then oldest — so all of
 * it landed in one chat.
 *
 * This is that choice, once, with a purpose attached.
 *
 * The fallback is the load-bearing part. A purpose nobody has ticked still
 * has to go somewhere, so the ordering puts a ticked group first and then
 * falls through to exactly what it picked before. Untick everything and the
 * client is still reachable; the worst case is where we already were, never
 * silence. That matters most for `payments` — a config mistake that quietly
 * stops invoices being chased would cost real money.
 */
import "server-only";
import { execute, hasColumn, queryOne } from "./db";

export const PURPOSES = [
  {
    key: "approvals",
    column: "for_approvals",
    label: "Approvals",
    blurb: "Videos and posters for sign-off, and the 12-hour chase.",
  },
  /*
   * Footage is its own room, and asked for as one.
   *
   * It is the only thing here the client has to *do* something about before
   * we can work, and it is the loudest — three asks a day, every day, until
   * the file arrives. That belongs with whoever actually holds the camera
   * roll, which is rarely the person who signs work off.
   */
  {
    key: "footage",
    column: "for_footage",
    label: "Footage",
    blurb: "Asking for raw footage before a shoot is due — three times a day until it lands.",
  },
  {
    key: "payments",
    column: "for_payments",
    label: "Payments",
    blurb: "Invoices, payment links and overdue reminders.",
  },
  {
    key: "updates",
    column: "for_updates",
    label: "Updates",
    blurb: "The month's plan, monthly reports, and 'your post is live'.",
  },
  {
    key: "chat",
    column: "for_chat",
    label: "Assistant replies",
    blurb: "Whether the assistant answers ordinary messages in this group.",
  },
] as const;

export type Purpose = (typeof PURPOSES)[number]["key"];

const columnOf = (p: Purpose): string => PURPOSES.find((x) => x.key === p)!.column;

/**
 * Which purpose a reminder kind belongs to.
 *
 * Kept here rather than beside the reminder rules because the console, the
 * assistant and the nightly run all need the same answer, and three copies
 * would send the same reminder to three different chats.
 */
const REMINDER_PURPOSE: Record<string, Purpose> = {
  approval_chase: "approvals",
  auto_approve: "approvals",
  footage_due: "footage",
  monthly_plan: "updates",
  invoice_due: "payments",
  team_digest: "updates",
  expense_due: "updates",
};

export const purposeOfReminder = (kind: string): Purpose => REMINDER_PURPOSE[kind] ?? "updates";

/**
 * The ORDER BY that picks a client's group for one job.
 *
 * Returned as SQL rather than a group id because the callers are five
 * different shapes — a GROUP_CONCAT inside a derived table, a LIMIT 1, a raw
 * `conn.execute` inside a transaction — and only the ordering is common to
 * them. `alias` is the table alias in the caller's query, or empty.
 *
 * On a database that has not run the migration the purpose term drops out and
 * this is byte-for-byte the ordering every one of those queries already had.
 */
export async function groupOrderSql(purpose: Purpose, alias = ""): Promise<string> {
  const col = columnOf(purpose);
  const a = alias ? `${alias}.` : "";
  const first = (await hasColumn("whatsapp_groups", col).catch(() => false))
    ? `${a}${col} DESC, `
    : "";
  return `${first}${a}is_default DESC, ${a}id ASC`;
}

/**
 * May this group be used for this job at all?
 *
 * Unlike the ordering above there is no fallback here, because there is
 * nothing to fall back to: this answers "should the assistant open its mouth
 * in this chat", and the honest answer to an unticked box is no. An
 * unmigrated column and an unknown group both read as yes, which is what
 * happened before either existed.
 */
export async function groupAllows(groupId: string, purpose: Purpose): Promise<boolean> {
  const col = columnOf(purpose);
  if (!(await hasColumn("whatsapp_groups", col).catch(() => false))) return true;
  const row = await queryOne<{ on: number }>(
    `SELECT ${col} AS \`on\` FROM whatsapp_groups WHERE group_id = ? AND is_active = 1`,
    [groupId]
  ).catch(() => null);
  return row ? Number(row.on) === 1 : true;
}

/**
 * Which purposes this database can actually store.
 *
 * Same trap as the message switches: a column that has not been applied reads
 * as ticked and springs back the moment it is saved, which is indistinguishable
 * from a save that does not work — and was reported as one.
 */
export async function storablePurposes(): Promise<Purpose[]> {
  const out: Purpose[] = [];
  for (const p of PURPOSES) {
    if (await hasColumn("whatsapp_groups", p.column).catch(() => false)) out.push(p.key);
  }
  return out;
}

/**
 * Read the ticks off a group row.
 *
 * Pure, and takes the row rather than an id, so the screen listing a client's
 * groups makes no extra query per row. A column that isn't there yet reads as
 * ticked — same rule as everywhere else.
 */
export function purposesOn(row: Record<string, unknown>): Purpose[] {
  return PURPOSES.filter(
    (p) => row[p.column] === undefined || row[p.column] === null || Number(row[p.column]) === 1
  ).map((p) => p.key);
}

/** Save the ticks. Columns the database doesn't have yet are skipped, not failed on. */
export async function setGroupPurposes(groupId: string, on: Purpose[]): Promise<void> {
  const sets: string[] = [];
  const vals: number[] = [];
  for (const p of PURPOSES) {
    if (!(await hasColumn("whatsapp_groups", p.column).catch(() => false))) continue;
    sets.push(`${p.column} = ?`);
    vals.push(on.includes(p.key) ? 1 : 0);
  }
  if (!sets.length) return;
  await execute(`UPDATE whatsapp_groups SET ${sets.join(", ")} WHERE group_id = ?`, [
    ...vals,
    groupId,
  ]);
}
