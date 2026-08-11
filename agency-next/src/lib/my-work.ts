/**
 * What one editor or designer has been given, and how far through it is.
 *
 * Both roles had somewhere to *do* the work — the poster board, Today's tasks —
 * and nowhere to see the shape of it. "How many clients am I on, how much is
 * left, what is sitting with the boss" needed three screens they cannot open
 * and a question to somebody who can.
 *
 * Everything here is scoped to `assigned_to = this user` and nothing else. Not
 * as a filter over an agency-wide query, which is one forgotten clause away
 * from showing a designer the whole book, but as the only thing any of these
 * queries can express.
 */
import "server-only";
import { query, queryOne, hasColumn } from "./db";
import type { SessionUser } from "./auth";

export type MyWorkStats = {
  /** Distinct clients with at least one task assigned to me this month. */
  clients: number;
  /** Everything assigned to me this month, cancelled and rejected aside. */
  assigned: number;
  /** Finished and out the door — posted, or approved and scheduled. */
  done: number;
  /** Made, and sitting with the super admin for their look. */
  withAdmin: number;
  /** Sent on to the client, waiting on them. */
  withClient: number;
  /** Sent back for changes. Mine again. */
  changes: number;
  /** Not started or mid-edit — the actual to-do list. */
  toDo: number;
  /** Of the to-do, the ones whose date has passed. */
  overdue: number;
  /** Of the to-do, the ones due today. */
  dueToday: number;
};

export type MyClientRow = {
  clientId: number;
  company: string;
  assigned: number;
  done: number;
  withAdmin: number;
  toDo: number;
  /** Soonest unfinished date, so a row says when it next needs attention. */
  nextDue: string | null;
};

export type MyWork = {
  month: string;
  stats: MyWorkStats;
  clients: MyClientRow[];
  /** The next few things to actually pick up, soonest first. */
  upNext: {
    id: number;
    title: string;
    company: string;
    status: string;
    dueDate: string | null;
    overdue: boolean;
  }[];
};

/**
 * Statuses grouped the way the person doing the work thinks about them.
 *
 * `caption_ready` is the pivot: the editor has finished, and it is now waiting
 * for a super admin to look at it before any client sees it. Called
 * "with the super admin" rather than "in review", which never said whose
 * review and left designers assuming the client already had it.
 */
const DONE = "('posted','completed','approved','scheduled')";
const WITH_ADMIN = "('caption_ready')";
const WITH_CLIENT = "('content_review','review')";
const TO_DO = "('pending','waiting_for_raw','raw_uploaded','editing','changes_requested','resolved')";
const COUNTS = "d.status NOT IN ('cancelled','rejected')";

/** The month key this dashboard reports on. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

export async function getMyWork(user: SessionUser, month = thisMonth()): Promise<MyWork> {
  const me = Math.trunc(Number(user.id));
  const mine = `d.assigned_to = ${me} AND d.month_key = ? AND ${COUNTS}`;

  const stats = await queryOne<Record<string, unknown>>(
    `SELECT
       COUNT(DISTINCT d.client_id)                                  AS clients,
       COUNT(*)                                                     AS assigned,
       COALESCE(SUM(d.status IN ${DONE}),0)                         AS done,
       COALESCE(SUM(d.status IN ${WITH_ADMIN}),0)                   AS withAdmin,
       COALESCE(SUM(d.status IN ${WITH_CLIENT}),0)                  AS withClient,
       COALESCE(SUM(d.status = 'changes_requested'),0)              AS changes,
       COALESCE(SUM(d.status IN ${TO_DO}),0)                        AS toDo,
       COALESCE(SUM(d.status IN ${TO_DO} AND d.due_date < CURDATE()),0)  AS overdue,
       COALESCE(SUM(d.status IN ${TO_DO} AND d.due_date = CURDATE()),0)  AS dueToday
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE c.status <> 'churned' AND ${mine}`,
    [month]
  );

  const clients = await query<Record<string, unknown>>(
    `SELECT c.id AS clientId, c.company_name AS company,
            COUNT(*)                                        AS assigned,
            COALESCE(SUM(d.status IN ${DONE}),0)            AS done,
            COALESCE(SUM(d.status IN ${WITH_ADMIN}),0)      AS withAdmin,
            COALESCE(SUM(d.status IN ${TO_DO}),0)           AS toDo,
            MIN(CASE WHEN d.status IN ${TO_DO} THEN d.due_date END) AS nextDue
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND ${mine}
      GROUP BY c.id, c.company_name
      ORDER BY (COALESCE(SUM(d.status IN ${TO_DO}),0) = 0), c.company_name`,
    [month]
  );

  /*
   * The next few to pick up — across every month, not just this one.
   *
   * The counts above are a month's report; this is a worklist, and a task left
   * over from last month is the first thing that should be picked up, not the
   * one thing the page hides.
   */
  const upNext = await query<Record<string, unknown>>(
    `SELECT d.id, d.title, c.company_name AS company, d.status, d.due_date AS dueDate,
            (d.due_date IS NOT NULL AND d.due_date < CURDATE()) AS overdue
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.assigned_to = ${me} AND ${COUNTS}
        AND d.status IN ${TO_DO}
      ORDER BY d.due_date IS NULL, d.due_date ASC, d.id ASC
      LIMIT 8`
  );

  const n = (v: unknown) => Number(v ?? 0);
  return {
    month,
    stats: {
      clients: n(stats?.clients),
      assigned: n(stats?.assigned),
      done: n(stats?.done),
      withAdmin: n(stats?.withAdmin),
      withClient: n(stats?.withClient),
      changes: n(stats?.changes),
      toDo: n(stats?.toDo),
      overdue: n(stats?.overdue),
      dueToday: n(stats?.dueToday),
    },
    clients: clients.map((r) => ({
      clientId: n(r.clientId),
      company: String(r.company),
      assigned: n(r.assigned),
      done: n(r.done),
      withAdmin: n(r.withAdmin),
      toDo: n(r.toDo),
      nextDue: r.nextDue ? String(r.nextDue).slice(0, 10) : null,
    })),
    upNext: upNext.map((r) => ({
      id: n(r.id),
      title: String(r.title),
      company: String(r.company),
      status: String(r.status),
      dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
      overdue: Boolean(Number(r.overdue)),
    })),
  };
}

/**
 * Months this person has work in, newest first — for the month picker.
 *
 * Their own months, not the agency's: a designer who joined in July should not
 * be offered a January that would come back empty.
 */
export async function myMonths(user: SessionUser): Promise<string[]> {
  const rows = await query<{ month_key: string }>(
    `SELECT DISTINCT month_key FROM deliverables
      WHERE assigned_to = ? AND month_key IS NOT NULL AND month_key <> ''
      ORDER BY month_key DESC LIMIT 12`,
    [Math.trunc(Number(user.id))]
  );
  const months = rows.map((r) => r.month_key);
  // Always offer the current month, even before anything is assigned in it —
  // an empty current month is a real answer, and its absence looks like a bug.
  return months.includes(thisMonth()) ? months : [thisMonth(), ...months];
}

/**
 * Work this person finished that is still waiting on the super admin.
 *
 * Shown to them because it is the one part of their pipeline they cannot move
 * and would otherwise have no sight of — "I sent that three days ago" is a
 * fair question, and the answer should be on their own screen.
 */
export async function awaitingAdminReview(user: SessionUser): Promise<
  { id: number; title: string; company: string; since: string | null }[]
> {
  const hasUpdated = await hasColumn("deliverables", "updated_at");
  const since = hasUpdated ? "d.updated_at" : "d.created_at";
  return query(
    `SELECT d.id, d.title, c.company_name AS company, ${since} AS since
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.assigned_to = ?
        AND d.status IN ${WITH_ADMIN}
      ORDER BY ${since} ASC LIMIT 20`,
    [Math.trunc(Number(user.id))]
  );
}
