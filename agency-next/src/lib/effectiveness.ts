/**
 * Team efficiency over a date range.
 *
 * One number per person: what they delivered, against what they could have
 * delivered in the same days.
 *
 *     efficiency = deliveries ÷ (days in range × capacity per day)
 *
 * So eight a day over eleven days is a capacity of 88, and 147 against it is
 * 167%. Under 100% is short of capacity, over it is beyond — and the figure is
 * never capped, because the whole point of a capacity is to see who is past it.
 *
 * **What counts as a delivery.** A task counts on the day it *moved forward* —
 * reached editing hand-off, review, approval or posting — not the day it was
 * created or the day it is due. For the person doing the work that is the
 * honest measure. `updated_at` is the closest thing the schema has to "when it
 * moved", and an unrelated edit touches it too; that is said on the page
 * rather than implied away.
 *
 * **Nobody is scored against a capacity they were not given.** Capacity 0
 * means unset, not zero — such a person is listed with their deliveries and no
 * percentage, because a red 0% for having been forgotten is a lie about them.
 */
import "server-only";
import { query, hasColumn } from "./db";
import { ASSIGNABLE_ROLES, sqlRoleList } from "./roles";

/** Statuses that mean the person's own part of a task is finished. */
const DELIVERED =
  "('caption_ready','review','approved','scheduled','posted','completed','resolved')";

export type MemberEfficiency = {
  id: number;
  name: string;
  role: string;
  /** Tasks they moved forward inside the range. */
  deliveries: number;
  /** Their expected output per day. 0 means nobody set one. */
  capacityPerDay: number;
  /** capacityPerDay × days in range. 0 when no capacity is set. */
  capacity: number;
  /** deliveries ÷ capacity, as a percentage. Null without a capacity. */
  efficiency: number | null;
};

export type TeamEfficiency = {
  from: string;
  to: string;
  /** Days in the range, both ends counted. The multiplier behind capacity. */
  days: number;
  members: MemberEfficiency[];
  totals: {
    people: number;
    /** People with a capacity set — the only ones in the team figure. */
    measured: number;
    deliveries: number;
    /** Deliveries by people who have a capacity. The numerator. */
    deliveriesMeasured: number;
    capacity: number;
    efficiency: number | null;
  };
  ready: boolean;
};

const EMPTY = (from: string, to: string): TeamEfficiency => ({
  from,
  to,
  days: 0,
  members: [],
  totals: {
    people: 0,
    measured: 0,
    deliveries: 0,
    deliveriesMeasured: 0,
    capacity: 0,
    efficiency: null,
  },
  ready: false,
});

/**
 * Floored, not rounded.
 *
 * Rounding would show 99.6% as 100% — "cleared capacity" for somebody who did
 * not — and 37.5% as 38%. A figure people are measured by should never round
 * in their favour across the line that matters, so it always reports the
 * percentage actually reached.
 */
const pct = (done: number, capacity: number): number | null =>
  capacity > 0 ? Math.floor((done / capacity) * 100) : null;

/** Whole days from `from` to `to`, both ends counted. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * The report for one date range.
 *
 * Deliveries are counted in SQL per person rather than pulled and grouped
 * here, so this stays one round trip however large the team gets.
 */
export async function teamEfficiency(from: string, to: string): Promise<TeamEfficiency> {
  if (!(await hasColumn("users", "daily_target"))) return EMPTY(from, to);
  if (!(await hasColumn("deliverables", "updated_at"))) return EMPTY(from, to);

  const days = daysBetween(from, to);
  if (days === 0) return { ...EMPTY(from, to), ready: true };

  const rows = await query<{
    id: number;
    name: string;
    role: string;
    daily_target: number;
    deliveries: number;
  }>(
    `SELECT u.id, u.name, u.role, u.daily_target,
            COALESCE(SUM(
              d.status IN ${DELIVERED}
              AND DATE(d.updated_at) BETWEEN ? AND ?
            ), 0) AS deliveries
       FROM users u
       LEFT JOIN deliverables d ON d.assigned_to = u.id
      WHERE u.is_active = 1 AND u.role IN (${sqlRoleList(ASSIGNABLE_ROLES)})
      GROUP BY u.id, u.name, u.role, u.daily_target
      ORDER BY u.daily_target = 0, u.name`,
    [from, to]
  );

  const members: MemberEfficiency[] = rows.map((r) => {
    const capacityPerDay = Number(r.daily_target) || 0;
    const deliveries = Number(r.deliveries) || 0;
    const capacity = capacityPerDay * days;
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      deliveries,
      capacityPerDay,
      capacity,
      efficiency: pct(deliveries, capacity),
    };
  });

  const measured = members.filter((m) => m.capacity > 0);
  const capacity = measured.reduce((s, m) => s + m.capacity, 0);
  const deliveriesMeasured = measured.reduce((s, m) => s + m.deliveries, 0);

  return {
    from,
    to,
    days,
    members,
    totals: {
      people: members.length,
      measured: measured.length,
      deliveries: members.reduce((s, m) => s + m.deliveries, 0),
      deliveriesMeasured,
      capacity,
      efficiency: pct(deliveriesMeasured, capacity),
    },
    ready: true,
  };
}
