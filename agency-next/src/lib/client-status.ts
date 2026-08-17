/**
 * Which clients' work counts as work.
 *
 * A client has four statuses — active, paused, inactive, churned — and until
 * now every query in the portal asked the same single question about them:
 * `status <> 'churned'`. That is the right question for "is this still a
 * client of ours": a churned one is gone, and a paused one is coming back, so
 * reports, invoices and the assistant should all still see them.
 *
 * It is the wrong question for "what is on the floor". Setting a client to
 * Inactive removed them from the agency's day in every sense a person means
 * by it, and their thirty-four unfinished videos went on being counted as due
 * today, upcoming and — worst of the three — overdue. A board that says you
 * are late on work you agreed to stop is not just noise; it is the number
 * people use to decide what to do next.
 *
 * So there are two questions now, and they are asked in different places.
 * This is the narrow one. It belongs on anything that counts, schedules or
 * chases work, and nowhere else:
 *
 *   - the dashboard's own numbers, and the workload split beneath them
 *   - the boards somebody works from
 *   - the reminders that go out unattended, which is the sharpest case —
 *     an inactive client being chased on WhatsApp for footage is a message
 *     to somebody the agency has stopped working with
 *
 * `COALESCE` because a row whose status was never set predates all of this
 * and is plainly still live work. Without it `NOT IN` returns NULL for that
 * row and drops it, which is how a filter meant to hide four clients hides a
 * hundred tasks.
 */

/** Statuses whose work is no longer being produced. */
export const NOT_ON_THE_FLOOR = ["churned", "inactive", "paused"] as const;

/**
 * SQL for "this client's work still counts", to be interpolated into a WHERE.
 *
 * @param alias the `clients` table alias in the query, or "" when it is the
 *              only table and the column is bare.
 */
export function onTheFloor(alias = "c"): string {
  const col = alias ? `${alias}.status` : "status";
  return `COALESCE(${col},'active') NOT IN (${NOT_ON_THE_FLOOR.map((s) => `'${s}'`).join(",")})`;
}

/** The same question, asked of a status already in hand rather than in SQL. */
export function isOnTheFloor(status: string | null | undefined): boolean {
  return !NOT_ON_THE_FLOOR.includes((status || "active") as (typeof NOT_ON_THE_FLOOR)[number]);
}
