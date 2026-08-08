/**
 * The messages the agency would otherwise have to remember to send.
 *
 * Every rule here follows the same shape: find what is overdue for a nudge,
 * claim it, then send. Claiming first is the whole design — a row is inserted
 * into `whatsapp_reminders` with a unique (kind, scope_key), and only an
 * insert that actually took the key is allowed to send. Two overlapping runs
 * therefore cannot both nudge, and a crash halfway through repeats nothing on
 * the next run. The cost is the opposite failure: a claim that succeeds and
 * then fails to send is not retried. That is the right way round — a client
 * chased twice by a robot is worse than a client chased once, late, by a
 * person who noticed.
 *
 * Nothing here invents a schedule. Every date comes from the portal's own
 * data, so a reminder can only ever say something the boards already say.
 */
import "server-only";
import { query, execute, hasColumn } from "./db";
import { sendTextToGroup } from "./whatsapp-service-client";
import { fmtDate, money } from "./utils";

export type ReminderKind =
  | "approval_chase"
  | "footage_due"
  | "monthly_plan"
  | "invoice_due"
  | "team_digest";

export type ReminderSummary = {
  ran: boolean;
  reason?: string;
  sent: Record<string, number>;
  failed: number;
};

/** Hours a video may sit unanswered before the group hears about it. */
const CHASE_AFTER_HOURS = 24;
/** Days before a shoot is due that we ask for the footage. */
const FOOTAGE_WARNING_DAYS = 3;

/**
 * Take the right to send one reminder, or find it already taken.
 *
 * Returns true only for the caller that actually inserted the row. The unique
 * key does the arbitration, so this is safe against two runners racing.
 */
async function claim(
  kind: ReminderKind,
  scopeKey: string,
  meta: { clientId?: number | null; deliverableId?: number | null; groupId?: string | null } = {}
): Promise<boolean> {
  const res = await execute(
    `INSERT IGNORE INTO whatsapp_reminders (kind, scope_key, client_id, deliverable_id, group_id)
     VALUES (?,?,?,?,?)`,
    [kind, scopeKey, meta.clientId ?? null, meta.deliverableId ?? null, meta.groupId ?? null]
  );
  return (res.affectedRows ?? 0) > 0;
}

/** Give the claim back, so a send that never happened can be tried again. */
async function unclaim(kind: ReminderKind, scopeKey: string): Promise<void> {
  await execute("DELETE FROM whatsapp_reminders WHERE kind = ? AND scope_key = ?", [
    kind,
    scopeKey,
  ]);
}

type Target = { client_id: number; company_name: string; group_id: string };

/**
 * Exactly one group per client, joined as a subquery.
 *
 * A client may have several linked groups, so joining `whatsapp_groups`
 * directly multiplies the rows and a reminder goes out once per group.
 * Grouping to hide that is worse: MySQL's only_full_group_by rejects it
 * outright, and where it doesn't, the group chosen is whichever the optimiser
 * happened to reach — so the same client could be chased in a different chat
 * each week.
 *
 * The default group wins, then the oldest. Both stable, so a client is always
 * addressed in the same place.
 */
const ONE_GROUP = `(
  SELECT client_id,
         SUBSTRING_INDEX(GROUP_CONCAT(group_id ORDER BY is_default DESC, id ASC), ',', 1) AS group_id
    FROM whatsapp_groups
   WHERE is_active = 1
   GROUP BY client_id
)`;

/** Clients we can actually reach: active, with a linked group. */
async function reachableClients(): Promise<Target[]> {
  return query<Target>(
    `SELECT c.id AS client_id, c.company_name, g.group_id
       FROM clients c
       JOIN ${ONE_GROUP} g ON g.client_id = c.id
      WHERE c.status <> 'churned'`
  );
}

/**
 * Send, and only keep the claim if it worked.
 *
 * A failed send releases the claim so the next run tries again, which is the
 * one case where repeating is right: nothing reached the client.
 */
async function deliver(
  kind: ReminderKind,
  scopeKey: string,
  groupId: string,
  text: string
): Promise<boolean> {
  try {
    await sendTextToGroup(groupId, text);
    return true;
  } catch (err) {
    console.warn(`[reminders] ${kind} ${scopeKey} failed:`, err instanceof Error ? err.message : err);
    await unclaim(kind, scopeKey);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Nobody replied
 * ------------------------------------------------------------------ */

/**
 * One nudge per video, a day after it was sent for approval.
 *
 * Scoped to the video rather than the client: a client with three videos
 * waiting gets three separate chases, which is correct — each one is a
 * different decision they owe.
 */
async function chaseApprovals(): Promise<{ sent: number; failed: number }> {
  const rows = await query<{
    id: number;
    title: string;
    client_id: number;
    group_id: string;
    waiting_since: string;
  }>(
    `SELECT d.id, d.title, d.client_id, g.group_id,
            MAX(s.created_at) AS waiting_since
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id AND c.status <> 'churned'
       JOIN ${ONE_GROUP} g ON g.client_id = c.id
       JOIN whatsapp_send_log s ON s.deliverable_id = d.id AND s.status IN ('sent','delivered','read')
      WHERE d.status IN ('content_review','review')
      GROUP BY d.id, d.title, d.client_id, g.group_id
     HAVING MAX(s.created_at) < DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 50`,
    [CHASE_AFTER_HOURS]
  );

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `d:${r.id}`;
    if (!(await claim("approval_chase", key, { clientId: r.client_id, deliverableId: r.id, groupId: r.group_id })))
      continue;
    const text =
      `Just a gentle reminder — *${r.title}* is still waiting for your approval.\n\n` +
      `Reply *OK* to approve, or *change* followed by what you'd like different. ` +
      `A voice note works too.`;
    (await deliver("approval_chase", key, r.group_id, text)) ? sent++ : failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 2. We still need footage
 * ------------------------------------------------------------------ */

/**
 * Ask for raw footage three days before it is needed.
 *
 * Grouped into one message per client per day. Four separate "we need
 * footage" messages in a row reads as a malfunction, and the client's job is
 * the same either way: send a link.
 */
async function requestFootage(): Promise<{ sent: number; failed: number }> {
  const rows = await query<{
    client_id: number;
    group_id: string;
    due_date: string;
    titles: string;
    n: number;
  }>(
    `SELECT d.client_id, g.group_id, d.due_date,
            GROUP_CONCAT(d.title ORDER BY d.id SEPARATOR '||') AS titles,
            COUNT(*) AS n
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id AND c.status <> 'churned'
       JOIN ${ONE_GROUP} g ON g.client_id = c.id
      WHERE d.status IN ('pending','waiting_for_raw')
        AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')
        AND d.due_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)
      GROUP BY d.client_id, g.group_id, d.due_date
      LIMIT 50`,
    [FOOTAGE_WARNING_DAYS]
  );

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `c:${r.client_id}:${r.due_date}`;
    if (!(await claim("footage_due", key, { clientId: r.client_id, groupId: r.group_id }))) continue;

    const list = r.titles.split("||").slice(0, 8).map((t) => `• ${t}`).join("\n");
    const n = Number(r.n);
    const text =
      `We're due to start editing on *${fmtDate(r.due_date)}* and we don't have your footage yet.\n\n` +
      `${n === 1 ? "This one" : `These ${n}`}:\n${list}\n\n` +
      `Just reply with a Google Drive link and we'll take it from there.`;
    (await deliver("footage_due", key, r.group_id, text)) ? sent++ : failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 4. What is going out this month
 * ------------------------------------------------------------------ */

/** The month's schedule, once, at the start of it. */
async function sendMonthlyPlan(month: string): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  for (const t of await reachableClients()) {
    const key = `c:${t.client_id}:${month}`;
    const items = await query<{ title: string; due_date: string | null; content_category: string | null }>(
      `SELECT title, COALESCE(scheduled_at, due_date) AS due_date, content_category
         FROM deliverables
        WHERE client_id = ? AND month_key = ? AND status NOT IN ('cancelled','rejected')
        ORDER BY due_date IS NULL, due_date ASC LIMIT 40`,
      [t.client_id, month]
    );
    if (items.length === 0) continue; // nothing planned is not worth a message
    if (!(await claim("monthly_plan", key, { clientId: t.client_id, groupId: t.group_id }))) continue;

    const lines = items
      .map((i) => `• ${i.due_date ? fmtDate(i.due_date) : "TBC"} — ${i.title}`)
      .join("\n");
    const text =
      `*This month's plan* — ${items.length} piece${items.length === 1 ? "" : "s"} of content:\n\n${lines}\n\n` +
      `We'll send each one here for your approval before it goes out.`;
    (await deliver("monthly_plan", key, t.group_id, text)) ? sent++ : failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 5. An invoice is unpaid
 * ------------------------------------------------------------------ */

/**
 * Once a week per invoice, not once a day.
 *
 * The scope key carries the ISO week, so the reminder repeats weekly for as
 * long as it stays unpaid without becoming daily nagging.
 */
async function remindInvoices(): Promise<{ sent: number; failed: number }> {
  const rows = await query<{
    id: number;
    invoice_no: string;
    total: number;
    due_date: string | null;
    client_id: number;
    group_id: string;
    week: string;
  }>(
    `SELECT i.id, i.invoice_no, i.total, i.due_date, i.client_id, g.group_id,
            DATE_FORMAT(CURDATE(), '%x-W%v') AS week
       FROM invoices i
       JOIN clients c ON c.id = i.client_id AND c.status <> 'churned'
       JOIN ${ONE_GROUP} g ON g.client_id = c.id
      WHERE i.status IN ('sent','overdue','partial')
        AND i.due_date IS NOT NULL AND i.due_date <= CURDATE()
      LIMIT 50`
  );

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `inv:${r.id}:${r.week}`;
    if (!(await claim("invoice_due", key, { clientId: r.client_id, groupId: r.group_id }))) continue;
    const text =
      `A quick reminder about invoice *${r.invoice_no}* for *${money(r.total)}*, ` +
      `which was due ${fmtDate(r.due_date)}.\n\n` +
      `You can view and pay it in your portal. Do let us know if anything looks wrong.`;
    (await deliver("invoice_due", key, r.group_id, text)) ? sent++ : failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 6. What the team owes today
 * ------------------------------------------------------------------ */

/**
 * One digest a day to the agency's own group.
 *
 * Only sent when there is something in it. A daily "nothing due" quickly
 * becomes a message nobody opens, which is worse than no message at all,
 * because then the one that matters goes unread too.
 */
async function teamDigest(teamGroupId: string, today: string): Promise<{ sent: number; failed: number }> {
  const key = `team:${today}`;
  const rows = await query<{ company_name: string; title: string; due_date: string | null; status: string }>(
    `SELECT c.company_name, d.title, d.due_date, d.status
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.due_date <= CURDATE()
        AND d.status NOT IN ('posted','completed','cancelled','rejected')
      ORDER BY d.due_date ASC LIMIT 25`
  );
  const awaiting = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.status IN ('content_review','review')`
  );

  if (rows.length === 0) return { sent: 0, failed: 0 };
  if (!(await claim("team_digest", key, { groupId: teamGroupId }))) return { sent: 0, failed: 0 };

  const overdue = rows.filter((r) => r.due_date && r.due_date < today).length;
  const lines = rows.map((r) => `• ${r.company_name} — ${r.title}`).join("\n");
  const text =
    `*Today* — ${rows.length} due or overdue${overdue ? ` (${overdue} late)` : ""}, ` +
    `${Number(awaiting[0]?.n) || 0} waiting on clients.\n\n${lines}`;
  return (await deliver("team_digest", key, teamGroupId, text))
    ? { sent: 1, failed: 0 }
    : { sent: 0, failed: 1 };
}

/* ------------------------------------------------------------------ */

/**
 * Run every rule once.
 *
 * Each is independent and wrapped, so one bad query cannot stop the rest —
 * a broken invoice reminder should not also silence the approval chases.
 */
export async function runReminders(
  opts: { teamGroupId?: string | null } = {}
): Promise<ReminderSummary> {
  const summary: ReminderSummary = { ran: false, sent: {}, failed: 0 };

  if (!(await hasColumn("whatsapp_reminders", "scope_key"))) {
    return { ...summary, reason: "The whatsapp_reminders table is missing — run Settings → Database." };
  }
  summary.ran = true;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const steps: [string, () => Promise<{ sent: number; failed: number }>][] = [
    ["approval_chase", chaseApprovals],
    ["footage_due", requestFootage],
    ["monthly_plan", () => sendMonthlyPlan(month)],
    ["invoice_due", remindInvoices],
  ];
  if (opts.teamGroupId) steps.push(["team_digest", () => teamDigest(opts.teamGroupId!, today)]);

  for (const [name, fn] of steps) {
    try {
      const r = await fn();
      summary.sent[name] = r.sent;
      summary.failed += r.failed;
    } catch (err) {
      summary.sent[name] = 0;
      summary.failed++;
      console.warn(`[reminders] ${name} threw:`, err instanceof Error ? err.message : err);
    }
  }
  return summary;
}
