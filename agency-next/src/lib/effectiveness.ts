/**
 * How the team is doing against what was asked of them.
 *
 * A daily target per person, and whether they hit it. Deliberately narrow:
 * this answers "is the work getting done" and nothing else. It is not a
 * ranking, and the numbers are only as fair as the targets somebody set.
 *
 * **What counts as done.** A task counts on the day it *moved forward*, not
 * the day it was created or the day it is due. For the person doing the work
 * that is the honest measure — an editor who cut four videos today did four
 * days' work whatever their due dates say.
 *
 * `updated_at` is the closest thing to "when it moved" the schema has. It is
 * imperfect: an unrelated edit touches it too. Said plainly here rather than
 * presented as precision it does not have, and the board says the same to
 * whoever reads it.
 *
 * **Nobody is measured against a target they were not given.** A person with
 * `daily_target = 0` is shown with their work and no verdict — an unset target
 * is not a target of zero, and rendering them as "0 of 0, achieved" would be a
 * green tick for having been forgotten.
 */
import "server-only";
import { query, hasColumn } from "./db";
import { ASSIGNABLE_ROLES, sqlRoleList } from "./roles";

/** Statuses that mean the person's own part is finished. */
const DONE_TODAY =
  "('caption_ready','review','approved','scheduled','posted','completed','resolved')";

export type MemberDay = {
  id: number;
  name: string;
  role: string;
  /** 0 when nobody has set one. Never treated as a target of zero. */
  target: number;
  /** Tasks they moved forward today. */
  done: number;
  /** Still open and assigned to them, whatever the date. */
  open: number;
  /** Open, assigned to them, and past its due date. */
  overdue: number;
  /** null when there is no target to judge against. */
  hit: boolean | null;
};

export type Effectiveness = {
  /** The database's today, so it matches the rows it is counting. */
  date: string;
  members: MemberDay[];
  totals: {
    people: number;
    /** People who have a target set. The denominator for "on target". */
    withTarget: number;
    onTarget: number;
    target: number;
    done: number;
    open: number;
    overdue: number;
  };
  ready: boolean;
};

const EMPTY: Effectiveness = {
  date: "",
  members: [],
  totals: { people: 0, withTarget: 0, onTarget: 0, target: 0, done: 0, open: 0, overdue: 0 },
  ready: false,
};

/**
 * Today's scoreboard.
 *
 * One query. Counting per person in SQL rather than pulling every task and
 * grouping in JS keeps this a single round trip whatever the team size, and
 * the board is on the super admin's dashboard where it is loaded constantly.
 */
export async function teamEffectiveness(): Promise<Effectiveness> {
  if (!(await hasColumn("users", "daily_target"))) return EMPTY;
  if (!(await hasColumn("deliverables", "updated_at"))) return EMPTY;

  const rows = await query<{
    id: number;
    name: string;
    role: string;
    daily_target: number;
    done: number;
    open: number;
    overdue: number;
    today: string;
  }>(
    `SELECT u.id, u.name, u.role, u.daily_target,
            CURDATE() AS today,
            COALESCE(SUM(d.status IN ${DONE_TODAY} AND DATE(d.updated_at) = CURDATE()), 0) AS done,
            COALESCE(SUM(d.status NOT IN ('posted','completed','cancelled','rejected')), 0) AS open,
            COALESCE(SUM(d.status NOT IN ('posted','completed','cancelled','rejected')
                         AND d.due_date IS NOT NULL AND d.due_date < CURDATE()), 0) AS overdue
       FROM users u
       LEFT JOIN deliverables d ON d.assigned_to = u.id
      WHERE u.is_active = 1 AND u.role IN (${sqlRoleList(ASSIGNABLE_ROLES)})
      GROUP BY u.id, u.name, u.role, u.daily_target
      ORDER BY u.daily_target = 0, u.name`
  );

  const members: MemberDay[] = rows.map((r) => {
    const target = Number(r.daily_target) || 0;
    const done = Number(r.done) || 0;
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      target,
      done,
      open: Number(r.open) || 0,
      overdue: Number(r.overdue) || 0,
      // No target set is no verdict, not a pass.
      hit: target > 0 ? done >= target : null,
    };
  });

  const withTarget = members.filter((m) => m.target > 0);
  return {
    date: rows[0]?.today ? String(rows[0].today).slice(0, 10) : "",
    members,
    totals: {
      people: members.length,
      withTarget: withTarget.length,
      onTarget: withTarget.filter((m) => m.hit).length,
      target: withTarget.reduce((s, m) => s + m.target, 0),
      done: members.reduce((s, m) => s + m.done, 0),
      open: members.reduce((s, m) => s + m.open, 0),
      overdue: members.reduce((s, m) => s + m.overdue, 0),
    },
    ready: true,
  };
}
