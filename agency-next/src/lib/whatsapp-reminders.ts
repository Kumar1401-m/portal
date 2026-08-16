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
import { query, execute, hasColumn, hasTable } from "./db";
import { sendTextToGroup } from "./whatsapp-service-client";
import { sendDueMessages } from "./reminder-outbox";
import { recordRun } from "./automation-runs";
import { notifyAdmins } from "./notify";
import { expensesNeedingNotice } from "./expenses";
import { money } from "./utils";
import { paymentLinkForInvoice } from "./payment-links";
import {
  approvalChaseText,
  footageText,
  invoiceText,
  monthlyPlanText,
  teamDigestText,
  type FootageStage,
} from "./reminder-messages";

/**
 * `auto_approve` is the one kind that isn't a message a person could send —
 * it is the portal deciding on the client's behalf — so it lives here rather
 * than in the sendable list the console offers.
 */
export type ReminderKind =
  | "approval_chase"
  | "auto_approve"
  | "footage_due"
  | "monthly_plan"
  | "invoice_due"
  | "team_digest"
  /**
   * The agency's own bills. The only kind here that never leaves the
   * building — it is claimed through the same table so it cannot be said
   * twice in a morning, but it is delivered to the portal, not a group.
   */
  | "expense_due";

export type ReminderSummary = {
  ran: boolean;
  reason?: string;
  sent: Record<string, number>;
  failed: number;
};

/**
 * Hours a video may sit unanswered before the group hears about it.
 *
 * Twelve, not twenty-four, now that silence approves at twenty-four: a
 * reminder that arrives at the same moment as the decision is not a reminder.
 * This gives the client half a day's warning that the clock is running.
 */
const CHASE_AFTER_HOURS = 12;

/**
 * Hours of silence that count as approval.
 *
 * Asked for directly, and it is a real business decision rather than a
 * technical one: after this, work goes to a client's public Instagram account
 * without them having said yes. Three things make that defensible, and all
 * three are load-bearing —
 *
 *   the client is chased at twelve hours, so silence is informed;
 *   the group is told at the moment it happens, not afterwards;
 *   the timeline records it as automatic, so nobody can later be told they
 *     approved something they did not.
 *
 * Remove any of those and this becomes a way to publish work behind a
 * client's back.
 */
const AUTO_APPROVE_AFTER_HOURS = 24;
/** Days before a shoot is due that we ask for the footage. */
/**
 * When footage is asked for: three times in a day, until it arrives.
 *
 * The first version asked once, on one day. The second asked three times but
 * spread them across a week — three days before, on the day, two days after —
 * which is not what was wanted either: the point is to catch somebody during
 * the day they are actually working, not once a week for three weeks.
 *
 * So three slots in a day, and every day the footage is still missing.
 * Morning, after lunch, and end of day, which is when a person is most likely
 * to be at a desk and able to find the file.
 *
 * Each one stops the moment the footage arrives — the query only ever returns
 * tasks with no link on them — and each is claimed per client, per day, per
 * slot, so a run happening twice cannot say the same thing twice.
 */
const FOOTAGE_SLOTS = [
  { at: "10:00", key: "morning", stage: "early" as FootageStage },
  { at: "13:30", key: "midday", stage: "due" as FootageStage },
  { at: "18:00", key: "evening", stage: "late" as FootageStage },
];

/**
 * How early the chase starts, in days before the due date.
 *
 * From here until the footage lands or the task stops needing it. Three a day
 * is a lot, which is the ask — the guard against nagging for ever is that a
 * task which is cancelled, rescheduled or fulfilled drops straight out of the
 * query.
 */
const FOOTAGE_LEAD_DAYS = 3;
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
/*
 * And the one place a client is excluded from all of it.
 *
 * Some clients would rather hear from a person than be chased by a robot, and
 * every reminder below reaches them through this join — so the opt-out lives
 * here rather than being repeated as a condition in five queries, one of
 * which somebody would eventually forget.
 *
 * Computed once, because it needs `hasColumn`: a database that has not run
 * the migration keeps chasing everybody, which is what it did before.
 */
let oneGroupSql: string | null = null;
async function ONE_GROUP(): Promise<string> {
  if (oneGroupSql) return oneGroupSql;
  const optOut = (await hasColumn("clients", "auto_reminders"))
    ? "AND client_id IN (SELECT id FROM clients WHERE auto_reminders = 1)"
    : "";
  oneGroupSql = `(
  SELECT client_id,
         SUBSTRING_INDEX(GROUP_CONCAT(group_id ORDER BY is_default DESC, id ASC), ',', 1) AS group_id
    FROM whatsapp_groups
   WHERE is_active = 1 ${optOut}
   GROUP BY client_id
)`;
  return oneGroupSql;
}

/** Clients we can actually reach: active, with a linked group. */
async function reachableClients(): Promise<Target[]> {
  return query<Target>(
    `SELECT c.id AS client_id, c.company_name, g.group_id
       FROM clients c
       JOIN ${await ONE_GROUP()} g ON g.client_id = c.id
      WHERE c.status <> 'churned'`
  );
}

/**
 * Send, and only keep the claim if it worked.
 *
 * A failed send releases the claim so the next run tries again, which is the
 * one case where repeating is right: nothing reached the client.
 *
 * The result is read, not the absence of an exception. `sendTextToGroup` never
 * throws — it reports a dead service as `{ ok: false }` — so a try/catch here
 * caught nothing and counted every failure as a send. That is the worst way
 * for this to break: the claim survives, so the reminder is never retried, and
 * the run reports success while the client hears nothing.
 */
async function deliver(
  kind: ReminderKind,
  scopeKey: string,
  groupId: string,
  text: string
): Promise<boolean> {
  try {
    const res = await sendTextToGroup(groupId, text);
    if (res.ok) return true;
    console.warn(`[reminders] ${kind} ${scopeKey} not sent:`, res.error);
  } catch (err) {
    console.warn(`[reminders] ${kind} ${scopeKey} threw:`, err instanceof Error ? err.message : err);
  }
  await unclaim(kind, scopeKey);
  return false;
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
/**
 * What this rule would act on, claims aside.
 *
 * Split out from the sending so the "what will the next run do" panel can ask
 * the same question the run itself asks. One query, two callers — a second
 * copy written for the preview would answer differently the first time either
 * was edited, and a preview that disagrees with the run is worse than none.
 */
async function findApprovalChases() {
  return query<{ id: number; title: string; client_id: number; group_id: string }>(
    `SELECT d.id, d.title, d.client_id, g.group_id
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id AND c.status <> 'churned'
       JOIN ${await ONE_GROUP()} g ON g.client_id = c.id
       JOIN whatsapp_send_log s ON s.deliverable_id = d.id AND s.status IN ('sent','delivered','read')
      WHERE d.status IN ('content_review','review')
      GROUP BY d.id, d.title, d.client_id, g.group_id
     HAVING MAX(s.created_at) < DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 50`,
    [CHASE_AFTER_HOURS]
  );
}

async function chaseApprovals(): Promise<{ sent: number; failed: number }> {
  const rows = await findApprovalChases();

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `d:${r.id}`;
    if (!(await claim("approval_chase", key, { clientId: r.client_id, deliverableId: r.id, groupId: r.group_id })))
      continue;
    // One title, so this is the single-video wording — the codes only appear
    // when a client is being chased about several at once, which this rule
    // never does.
    const text = approvalChaseText([{ title: r.title, video_code: null }]);
    if (await deliver("approval_chase", key, r.group_id, text)) sent++;
    else failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 1b. Still nobody replied — silence approves
 * ------------------------------------------------------------------ */

/**
 * Approve what the client never answered, a day after it was sent.
 *
 * Goes through recordApproval, the same path a real "ok" takes, rather than
 * writing a status directly. That matters: approving is not one UPDATE. It
 * moves the content gate to waiting-for-raw or the final gate to approved,
 * schedules the post, and writes the timeline — and a second implementation
 * of that would drift from the first the week either changed.
 *
 * Only videos actually delivered to the group qualify. A video that failed to
 * send has not been ignored by anyone, and approving it on the client's behalf
 * because our own send failed would be indefensible.
 */
async function findAutoApprovals() {
  return query<{ id: number; title: string; client_id: number; group_id: string }>(
    `SELECT d.id, d.title, d.client_id, g.group_id
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id AND c.status <> 'churned'
       JOIN ${await ONE_GROUP()} g ON g.client_id = c.id
       JOIN whatsapp_send_log s ON s.deliverable_id = d.id
            AND s.status IN ('sent','delivered','read')
      WHERE d.status IN ('content_review','review')
      GROUP BY d.id, d.title, d.client_id, g.group_id
     HAVING MAX(s.created_at) < DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 25`,
    [AUTO_APPROVE_AFTER_HOURS]
  );
}

async function autoApprove(): Promise<{ sent: number; failed: number }> {
  const rows = await findAutoApprovals();

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `d:${r.id}`;
    if (!(await claim("auto_approve", key, { clientId: r.client_id, deliverableId: r.id, groupId: r.group_id })))
      continue;

    try {
      const { recordApproval, ensureVideoCode } = await import("./whatsapp-approvals");
      /*
       * Name the video explicitly.
       *
       * Left to resolve from the group, recordApproval asks "what was this
       * group last asked about" — and rightly refuses when several videos are
       * waiting at once, because a client's bare "ok" really is ambiguous
       * there. Nothing is ambiguous here: this loop is holding the row. The
       * ambiguity guard exists for humans typing, not for us.
       */
      const res = await recordApproval({
        videoCode: await ensureVideoCode(r.id),
        command: "approve",
        // Named, not left blank: the timeline and the approvals board both
        // show who approved, and "—" there would read as a client who did.
        approvedBy: "Auto-approved after 24h",
        message: `No reply within ${AUTO_APPROVE_AFTER_HOURS} hours of sending.`,
        groupId: r.group_id,
        time: new Date().toISOString(),
      });
      if (!res.ok) {
        // Say why. A refusal here is the portal declining to approve, which is
        // a different thing from a crash and needs a different fix — silently
        // counting it as "failed" hides which.
        console.warn(`[reminders] auto_approve ${key} refused:`, res.error || "no reason given");
        await unclaim("auto_approve", key);
        failed++;
        continue;
      }
    } catch (err) {
      console.warn(`[reminders] auto_approve ${key} failed:`, err instanceof Error ? err.message : err);
      await unclaim("auto_approve", key);
      failed++;
      continue;
    }

    // Told at the moment it happens. A client who was busy can still say
    // "actually, change it" — and now knows they need to.
    const text =
      `We haven't heard back on *${r.title}*, so we're treating it as approved ` +
      `and moving it forward.\n\n` +
      `If you'd like anything changed, reply *change* and tell us — we'll sort it out.`;
    if (await deliver("auto_approve", key, r.group_id, text)) sent++;
    else failed++;
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
async function findFootageDue(lead: number) {
  return query<{
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
       JOIN ${await ONE_GROUP()} g ON g.client_id = c.id
      WHERE d.status IN ('pending','waiting_for_raw')
        AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')
        AND d.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
      GROUP BY d.client_id, g.group_id, d.due_date
      ORDER BY d.due_date ASC
      LIMIT 50`,
    // Everything from `lead` days out and anything already past — the chase
    // runs until the footage arrives, not until a date goes by.
    [lead]
  );
}

/**
 * The slot the clock is in, or null before the first one.
 *
 * Read from the database rather than this process. The times are the client's
 * working day and the database keeps IST, while a server an hour either side
 * of it would put the "10:00" message out at nine or eleven.
 *
 * A slot stays claimable until the next one, so a run that is late — or a
 * schedule that only fires twice — still sends the one it is in rather than
 * skipping it or firing all three at once.
 */
async function currentFootageSlot(): Promise<{ key: string; stage: FootageStage; today: string } | null> {
  const [now] = await query<{ hm: string; today: string }>(
    "SELECT DATE_FORMAT(NOW(), '%H:%i') AS hm, CURDATE() AS today"
  );
  if (!now) return null;
  const passed = FOOTAGE_SLOTS.filter((s) => now.hm >= s.at);
  const slot = passed[passed.length - 1];
  return slot ? { key: slot.key, stage: slot.stage, today: String(now.today).slice(0, 10) } : null;
}

async function requestFootage(): Promise<{ sent: number; failed: number }> {
  const slot = await currentFootageSlot();
  // Before the first slot of the day there is nothing to send. A run at 6am
  // should not use up the morning's message.
  if (!slot) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const rows = await findFootageDue(FOOTAGE_LEAD_DAYS);
  for (const r of rows) {
    /*
     * Claimed per client, per day, per slot. The date is in the key because
     * the chase repeats daily — without it the first day's claim would
     * silence every day after it.
     */
    const key = `c:${r.client_id}:${slot.today}:${slot.key}`;
    if (!(await claim("footage_due", key, { clientId: r.client_id, groupId: r.group_id }))) continue;

    const text = footageText(
      r.titles.split("||").map((title) => ({ title, due_date: r.due_date })),
      slot.stage
    );
    if (await deliver("footage_due", key, r.group_id, text)) sent++;
    else failed++;
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ *
 * 4. What is going out this month
 * ------------------------------------------------------------------ */

/** One client's month, as the plan message lists it. */
function findMonthItems(clientId: number, month: string) {
  return query<{ title: string; due_date: string | null }>(
    `SELECT title, COALESCE(scheduled_at, due_date) AS due_date
       FROM deliverables
      WHERE client_id = ? AND month_key = ? AND status NOT IN ('cancelled','rejected')
      ORDER BY due_date IS NULL, due_date ASC LIMIT 40`,
    [clientId, month]
  );
}

/** The month's schedule, once, at the start of it. */
async function sendMonthlyPlan(month: string): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  for (const t of await reachableClients()) {
    const key = `c:${t.client_id}:${month}`;
    const items = await findMonthItems(t.client_id, month);
    if (items.length === 0) continue; // nothing planned is not worth a message
    if (!(await claim("monthly_plan", key, { clientId: t.client_id, groupId: t.group_id }))) continue;

    const text = monthlyPlanText(items);
    if (await deliver("monthly_plan", key, t.group_id, text)) sent++;
    else failed++;
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
 *
 * **Only clients who were chosen for it.** Chasing money automatically is not
 * something to do to a whole book of clients by default — some are invoiced on
 * a handshake, some have a finance contact who is not in the WhatsApp group,
 * and some would simply take it badly. `auto_payment_reminders` is off unless
 * somebody ticks it, per client.
 *
 * The gate applies only where the column exists, so a database the migration
 * has not reached keeps behaving exactly as it did rather than silently going
 * quiet. Applying the migration is what switches everyone off until chosen —
 * which is the point of it.
 *
 * Sending by hand from Settings → Reminders is unaffected: a person deciding
 * to chase one client today needs no flag.
 */
async function findUnpaidInvoices() {
  const gated = (await hasColumn("clients", "auto_payment_reminders"))
    ? "AND c.auto_payment_reminders = 1"
    : "";
  return query<{
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
       JOIN ${await ONE_GROUP()} g ON g.client_id = c.id
      WHERE i.status IN ('sent','overdue','partial')
        AND i.due_date IS NOT NULL AND i.due_date <= CURDATE()
        ${gated}
      LIMIT 50`
  );
}

async function remindInvoices(): Promise<{ sent: number; failed: number }> {
  const rows = await findUnpaidInvoices();

  let sent = 0, failed = 0;
  for (const r of rows) {
    const key = `inv:${r.id}:${r.week}`;
    if (!(await claim("invoice_due", key, { clientId: r.client_id, groupId: r.group_id }))) continue;

    // A payable link rather than "pay it in your portal". Cached on the
    // invoice, so this week's reminder carries the same link as last week's
    // and a client who kept the older message can still use it.
    const link = await paymentLinkForInvoice(r.id);
    const text = invoiceText([
      {
        invoice_no: r.invoice_no,
        total: Number(r.total) || 0,
        due_date: r.due_date,
        payUrl: link.url,
        payable: link.payable,
      },
    ]);
    if (await deliver("invoice_due", key, r.group_id, text)) sent++;
    else failed++;
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

  const text = teamDigestText(rows, Number(awaiting[0]?.n) || 0, today);
  return (await deliver("team_digest", key, teamGroupId, text))
    ? { sent: 1, failed: 0 }
    : { sent: 0, failed: 1 };
}

/**
 * The agency's own bills, said once a day to the agency.
 *
 * Not a client reminder — nothing here leaves the building. It goes to the
 * portal's own notification list, so it works with no WhatsApp group linked
 * and no phone connected, which is the difference between a reminder that
 * exists and one that only exists on a good day.
 *
 * Claimed on the date like every other reminder, so two runs in one morning
 * do not say it twice.
 */
async function expenseNotice(today: string): Promise<{ sent: number; failed: number }> {
  if (!(await hasTable("expenses"))) return { sent: 0, failed: 0 };

  const due = await expensesNeedingNotice();
  if (due.length === 0) return { sent: 0, failed: 0 };
  if (!(await claim("expense_due", `expenses:${today}`))) return { sent: 0, failed: 0 };

  const late = due.filter((d) => d.overdue);
  const total = due.reduce((n, d) => n + d.amount, 0);

  // Named individually up to a point, because "3 payments due" makes somebody
  // open the board to find out which — and past a handful the list is the
  // thing nobody reads.
  const named = due
    .slice(0, 5)
    .map((d) => `• ${d.title} — ${money(d.amount)}${d.overdue ? " (overdue)" : `, due ${d.due_on}`}`)
    .join("\n");
  const more = due.length > 5 ? `\n…and ${due.length - 5} more.` : "";

  await notifyAdmins(
    "general",
    late.length > 0
      ? `💸 ${late.length} payment${late.length === 1 ? " is" : "s are"} overdue`
      : `💸 ${due.length} payment${due.length === 1 ? "" : "s"} coming up`,
    `${money(total)} in total.
${named}${more}`,
    "/expenses"
  );
  return { sent: 1, failed: 0 };
}

/* ------------------------------------------------------------------ *
 * What the next run would do
 * ------------------------------------------------------------------ */

/** Of these scope keys, the ones no reminder has been sent against yet. */
async function unclaimedCount(kind: ReminderKind, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const [row] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM whatsapp_reminders
      WHERE kind = ? AND scope_key IN (${keys.map(() => "?").join(",")})`,
    [kind, ...keys]
  );
  return keys.length - (Number(row?.n) || 0);
}

export type PendingReminders = {
  approval_chase: number;
  auto_approve: number;
  footage_due: number;
  monthly_plan: number;
  invoice_due: number;
  total: number;
};

/**
 * What the next automatic run would send, without sending anything.
 *
 * Every rule is asked through the same `find*` query it uses for real, then
 * the claims are subtracted — so this is not an estimate, it is the run
 * itself stopping one step short of WhatsApp.
 *
 * Worth having because "no reminders were sent yesterday" has two very
 * different causes. Either nothing was due, or nothing is running. A number
 * here plus a heartbeat in `automation_runs` tells them apart, and they need
 * opposite responses.
 */
export async function pendingReminders(month?: string): Promise<PendingReminders> {
  const m = month || new Date().toISOString().slice(0, 7);
  const zero: PendingReminders = {
    approval_chase: 0, auto_approve: 0, footage_due: 0,
    monthly_plan: 0, invoice_due: 0, total: 0,
  };
  if (!(await hasColumn("whatsapp_reminders", "scope_key"))) return zero;

  const count = async (fn: () => Promise<number>) => {
    try {
      return await fn();
    } catch (err) {
      // One rule that cannot be counted must not blank the whole panel.
      console.warn("[reminders] pending count failed:", err instanceof Error ? err.message : err);
      return 0;
    }
  };

  const out = { ...zero };

  out.approval_chase = await count(async () =>
    unclaimedCount("approval_chase", (await findApprovalChases()).map((r) => `d:${r.id}`))
  );
  out.auto_approve = await count(async () =>
    unclaimedCount("auto_approve", (await findAutoApprovals()).map((r) => `d:${r.id}`))
  );
  // All three asks, since "what would the next run do" means every one of them
  // that is due today — not only the first.
  out.footage_due = await count(async () => {
    const slot = await currentFootageSlot();
    if (!slot) return 0;
    const rows = await findFootageDue(FOOTAGE_LEAD_DAYS);
    return unclaimedCount(
      "footage_due",
      rows.map((r) => `c:${r.client_id}:${slot.today}:${slot.key}`)
    );
  });  out.invoice_due = await count(async () =>
    unclaimedCount("invoice_due", (await findUnpaidInvoices()).map((r) => `inv:${r.id}:${r.week}`))
  );
  out.monthly_plan = await count(async () => {
    // The same per-client loop the rule runs. A single clever aggregate would
    // be faster and would be a second definition of "has a plan worth sending".
    const keys: string[] = [];
    for (const t of await reachableClients()) {
      if ((await findMonthItems(t.client_id, m)).length > 0) keys.push(`c:${t.client_id}:${m}`);
    }
    return unclaimedCount("monthly_plan", keys);
  });

  out.total =
    out.approval_chase + out.auto_approve + out.footage_due + out.monthly_plan + out.invoice_due;
  return out;
}

/**
 * Clients the automatic reminders can never reach.
 *
 * Every rule joins through `whatsapp_groups`, so a client without a linked
 * group is silently skipped by all of them — no error, no message, nothing on
 * any screen. Naming them is the only way that becomes visible.
 */
export async function unreachableClients(): Promise<{ id: number; company_name: string }[]> {
  try {
    return await query<{ id: number; company_name: string }>(
      `SELECT c.id, c.company_name FROM clients c
        WHERE c.status <> 'churned'
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_groups g WHERE g.client_id = c.id AND g.is_active = 1
          )
        ORDER BY c.company_name`
    );
  } catch {
    // An install without the group table has nothing to report here, and the
    // page as a whole must still render — this is one card on it, not the point.
    return [];
  }
}

/** How many automatic reminders actually went out over the last week, by kind. */
export async function recentlySent(days = 7): Promise<{ kind: string; n: number }[]> {
  try {
    return await query<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM whatsapp_reminders
        WHERE sent_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY kind ORDER BY n DESC`,
      [days]
    );
  } catch {
    return [];
  }
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
    const reason = "The whatsapp_reminders table is missing — run Settings → Database.";
    // Recorded even though nothing ran. A job that is being called but cannot
    // work must not look identical to one nobody is calling.
    await recordRun("whatsapp_reminders", false, reason);
    return { ...summary, reason };
  }
  summary.ran = true;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const steps: [string, () => Promise<{ sent: number; failed: number }>][] = [
    /*
     * Anything a super admin scheduled by hand, first.
     *
     * A safety net rather than the mechanism: the outbox has its own runner on
     * a five-minute poll, and that is what makes "send it at 6pm" mean 6pm.
     * Including it here means that if the poll is ever switched off or broken,
     * a scheduled message goes out late rather than never — and late is a
     * problem someone notices and fixes.
     */
    ["outbox", async () => {
      const r = await sendDueMessages();
      return { sent: r.sent, failed: r.failed };
    }],
    ["approval_chase", chaseApprovals],
    // After the chase, so a video is never approved in the same run that first
    // reminded them about it.
    ["auto_approve", autoApprove],
    ["footage_due", requestFootage],
    ["monthly_plan", () => sendMonthlyPlan(month)],
    ["invoice_due", remindInvoices],
    // The agency's own bills. Last, and internal — everything above this line
    // goes to a client.
    ["expense_due", () => expenseNotice(today)],
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

  const total = Object.values(summary.sent).reduce((a, b) => a + b, 0);
  const detail = Object.entries(summary.sent)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  await recordRun(
    "whatsapp_reminders",
    summary.failed === 0,
    total === 0
      ? "Ran, nothing was due."
      : `Sent ${total}${detail ? ` — ${detail}` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}.`
  );
  return summary;
}
