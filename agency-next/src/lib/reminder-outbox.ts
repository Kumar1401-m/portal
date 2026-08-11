/**
 * Reminders written now and sent later.
 *
 * The nightly rules decide for themselves what to send and when. This is the
 * other half: a super admin writes the message, reads it, and picks the hour
 * it goes out. Two things follow from that and both are deliberate.
 *
 * **The wording is frozen.** What is stored is the text, not the recipe for
 * it. A message re-composed at send time could say something nobody approved —
 * a client's footage might arrive at 4pm and the 6pm reminder would then be
 * asking for something they already sent. Frozen text can go stale too, but it
 * goes stale visibly: it is on the schedule where anyone can read it and
 * cancel it.
 *
 * **Sending is claimed, not just marked.** A row moves to `sending` with a
 * conditional UPDATE, and only the caller whose UPDATE matched a row may send
 * it. Two runners overlapping — the five-minute poll and the nightly job, say —
 * therefore cannot both send the same message. Claiming before sending rather
 * than after means the failure mode is a message that never goes rather than
 * one that goes twice, which for a client-facing chase is the right way round.
 */
import "server-only";
import { query, queryOne, execute, hasColumn } from "./db";
import { sendTextToGroup } from "./whatsapp-service-client";
import { recordRun } from "./automation-runs";

/**
 * The clock a super admin types and reads times in.
 *
 * A key into the country table in `posting.ts` rather than a raw offset, so
 * scheduling a reminder and scheduling a post mean the same thing by "6pm" and
 * there is one place to change if the agency ever works from somewhere else.
 */
export const REMINDER_TIMEZONE = "india";

export type OutboxStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export type OutboxRow = {
  id: number;
  kind: string;
  client_id: number | null;
  company_name: string | null;
  group_id: string;
  group_label: string | null;
  body: string;
  send_at: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  created_by_name: string | null;
  created_at: string;
  sent_at: string | null;
};

/**
 * Where a client is written to.
 *
 * The default group when there is one, then the oldest — the same order the
 * automatic reminders use, so a client is always addressed in the same chat
 * whatever sent the message: the nightly rules, the console, or the assistant.
 * Three copies of this choice would eventually pick three different groups for
 * a client who has more than one.
 */
export async function groupForClient(
  clientId: number
): Promise<{ groupId: string; label: string } | null> {
  const row = await queryOne<{ group_id: string; group_name: string | null; company_name: string }>(
    `SELECT g.group_id, g.group_name, c.company_name
       FROM whatsapp_groups g JOIN clients c ON c.id = g.client_id
      WHERE g.client_id = ? AND g.is_active = 1
      ORDER BY g.is_default DESC, g.id ASC LIMIT 1`,
    [clientId]
  ).catch(() => null);
  if (!row) return null;
  return { groupId: row.group_id, label: row.group_name || row.company_name };
}

/** Attempts before a message is given up on rather than retried for ever. */
const MAX_ATTEMPTS = 4;

/** How many are sent in one pass, so a backlog can't run the function out of time. */
const BATCH = 15;

export const outboxReady = () => hasColumn("whatsapp_outbox", "send_at");

/**
 * Put a message on the schedule.
 *
 * `sendAt` is a MySQL DATETIME in UTC, matching every other scheduled time in
 * the portal. A time already past is allowed and simply goes out on the next
 * run — "send it now" and "send it at a time that has been and gone" should
 * not behave differently.
 */
export async function queueMessage(msg: {
  kind: string;
  clientId: number | null;
  groupId: string;
  groupLabel?: string | null;
  body: string;
  sendAt: string;
  createdBy?: number | null;
  createdByName?: string | null;
}): Promise<number> {
  const res = await execute(
    `INSERT INTO whatsapp_outbox
       (kind, client_id, group_id, group_label, body, send_at, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      msg.kind.slice(0, 32),
      msg.clientId ?? null,
      msg.groupId,
      msg.groupLabel?.slice(0, 190) ?? null,
      msg.body,
      msg.sendAt,
      msg.createdBy ?? null,
      msg.createdByName?.slice(0, 150) ?? null,
    ]
  );
  return Number(res.insertId) || 0;
}

/**
 * Stop one going out.
 *
 * Only from `scheduled`. A row already claimed as `sending` is in someone
 * else's hands and may have reached WhatsApp — cancelling it would put
 * "cancelled" in the log against a message the client can read.
 */
export async function cancelMessage(id: number): Promise<boolean> {
  const res = await execute(
    "UPDATE whatsapp_outbox SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'",
    [Math.trunc(Number(id)) || 0]
  );
  return (res.affectedRows ?? 0) > 0;
}

/** Everything still to go, soonest first. */
export function listScheduled(limit = 50): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    `SELECT o.*, c.company_name
       FROM whatsapp_outbox o LEFT JOIN clients c ON c.id = o.client_id
      WHERE o.status IN ('scheduled','sending')
      ORDER BY o.send_at ASC LIMIT ${Math.trunc(limit)}`
  );
}

/** What has already been through, newest first — sent, failed and cancelled. */
export function listHistory(limit = 25): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    `SELECT o.*, c.company_name
       FROM whatsapp_outbox o LEFT JOIN clients c ON c.id = o.client_id
      WHERE o.status IN ('sent','failed','cancelled')
      ORDER BY COALESCE(o.sent_at, o.created_at) DESC LIMIT ${Math.trunc(limit)}`
  );
}

/**
 * Take one message for sending, or find someone else already has it.
 *
 * `status = 'scheduled'` in the WHERE clause is the lock. MySQL applies it
 * atomically per row, so of two runners reaching the same row exactly one gets
 * `affectedRows = 1`.
 */
async function claimForSending(id: number): Promise<boolean> {
  const res = await execute(
    `UPDATE whatsapp_outbox
        SET status = 'sending', attempts = attempts + 1, claimed_at = ?
      WHERE id = ? AND status = 'scheduled'`,
    [nowUtc(), id]
  );
  return (res.affectedRows ?? 0) > 0;
}

/**
 * Minutes a claim may go unfinished before the message is offered again.
 *
 * Longer than any send can take — a WhatsApp text is seconds, and the route
 * that drives this is capped at sixty. Long enough that a slow send is never
 * picked up twice; short enough that a killed process costs one poll.
 */
const CLAIM_EXPIRY_MINUTES = 10;

/**
 * Free messages whose sender never came back.
 *
 * A serverless function can be killed at any point, including between claiming
 * a row and recording the result. Without this the row would sit in `sending`
 * for ever: never sent, never retried, and never showing as failed — the
 * quietest way for this feature to break.
 *
 * The attempt already counted stays counted, so a message that repeatedly
 * kills its runner still runs out of attempts rather than looping.
 */
async function releaseStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - CLAIM_EXPIRY_MINUTES * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const res = await execute(
    `UPDATE whatsapp_outbox
        SET status = 'scheduled',
            last_error = 'The sender stopped before it finished. Retried.'
      WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?)`,
    [cutoff]
  );
  return res.affectedRows ?? 0;
}

export type OutboxRunSummary = {
  ran: boolean;
  reason?: string;
  sent: number;
  failed: number;
  /** Messages taken back from a runner that died mid-send. Normally zero. */
  recovered?: number;
};

/**
 * Send everything whose time has come.
 *
 * Every time in this table — `send_at`, `sent_at`, the comparison below — is
 * written and read by the app in UTC, and never by `NOW()`. The database's own
 * clock is left out of it entirely: nothing in the connection pins the session
 * timezone, so a hosted MySQL sitting in IST would read a 6pm UTC schedule as
 * due five and a half hours early. One clock, ours, and the question of where
 * the database thinks it is never arises.
 *
 * A failed send goes back to `scheduled` for the next pass, until it has been
 * tried MAX_ATTEMPTS times — a WhatsApp service that is rebooting should not
 * cost the message, and a group id that no longer exists should not be retried
 * for ever.
 */
export async function sendDueMessages(): Promise<OutboxRunSummary> {
  if (!(await outboxReady())) {
    return { ran: false, reason: "The whatsapp_outbox table is missing — run Settings → Database.", sent: 0, failed: 0 };
  }

  // Before looking for work, take back anything a dead runner is still
  // holding — otherwise those rows are invisible to this query for ever.
  const recovered = await releaseStaleClaims();

  const due = await query<{ id: number; group_id: string; body: string; attempts: number }>(
    `SELECT id, group_id, body, attempts
       FROM whatsapp_outbox
      WHERE status = 'scheduled' AND send_at <= ?
      ORDER BY send_at ASC LIMIT ${BATCH}`,
    [nowUtc()]
  );

  let sent = 0;
  let failed = 0;

  for (const m of due) {
    if (!(await claimForSending(m.id))) continue;

    let error: string | null = null;
    try {
      const res = await sendTextToGroup(m.group_id, m.body);
      if (!res.ok) error = res.error;
      else {
        await execute(
          "UPDATE whatsapp_outbox SET status = 'sent', sent_at = ?, wa_message_id = ?, last_error = NULL WHERE id = ?",
          [nowUtc(), res.messageId ?? null, m.id]
        );
        sent++;
        continue;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Sending failed.";
    }

    // attempts was already incremented by the claim, so this row has now had
    // m.attempts + 1 tries.
    const exhausted = m.attempts + 1 >= MAX_ATTEMPTS;
    await execute(
      `UPDATE whatsapp_outbox SET status = ?, last_error = ? WHERE id = ?`,
      [exhausted ? "failed" : "scheduled", error?.slice(0, 500) ?? null, m.id]
    );
    if (exhausted) failed++;
  }

  /*
   * The heartbeat, on every pass including the empty ones.
   *
   * Empty is the normal answer here — the poll runs 288 times a day and most
   * of those have nothing to send. Recording only the busy passes would leave
   * a working poll looking dead for hours at a stretch, which is precisely the
   * confusion this exists to remove.
   */
  await recordRun(
    "whatsapp_outbox",
    true,
    sent || failed || recovered
      ? `Sent ${sent}${failed ? `, ${failed} gave up` : ""}${recovered ? `, ${recovered} recovered` : ""}.`
      : "Ran, nothing was due."
  );

  return { ran: true, sent, failed, ...(recovered ? { recovered } : {}) };
}

/**
 * Send one immediately, recording it the same way a scheduled one is.
 *
 * "Send now" could bypass the outbox and call the service directly, but then
 * half the messages the agency sends would be missing from the log — and the
 * log is what someone reads when a client says they were never told.
 */
export async function sendNow(msg: {
  kind: string;
  clientId: number | null;
  groupId: string;
  groupLabel?: string | null;
  body: string;
  createdBy?: number | null;
  createdByName?: string | null;
}): Promise<{ ok: boolean; error?: string; id: number }> {
  const id = await queueMessage({ ...msg, sendAt: nowUtc() });
  if (!(await claimForSending(id))) return { ok: false, error: "Couldn't claim the message.", id };

  try {
    const res = await sendTextToGroup(msg.groupId, msg.body);
    if (res.ok) {
      await execute(
        "UPDATE whatsapp_outbox SET status = 'sent', sent_at = ?, wa_message_id = ? WHERE id = ?",
        [nowUtc(), res.messageId ?? null, id]
      );
      return { ok: true, id };
    }
    // Left as `scheduled`, not `failed`: the service being down for a minute
    // shouldn't lose a message someone meant to send. The runner picks it up.
    await execute("UPDATE whatsapp_outbox SET status = 'scheduled', last_error = ? WHERE id = ?", [
      res.error.slice(0, 500),
      id,
    ]);
    return { ok: false, error: res.error, id };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Sending failed.";
    await execute("UPDATE whatsapp_outbox SET status = 'scheduled', last_error = ? WHERE id = ?", [
      error.slice(0, 500),
      id,
    ]);
    return { ok: false, error, id };
  }
}

/** Now, as the MySQL DATETIME string the rest of the portal stores. */
export function nowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
