/**
 * Whose group may be asked for raw footage.
 *
 * `needsRawFootage` in `raw-footage.ts` answers the other half — whether *this
 * piece of work* waits on a shoot. That one is about a task, it is pure, and it
 * stays pure so a client component can import it. This one is about a client,
 * it has to read the database, and it belongs only to the messages that leave
 * the building.
 *
 * ## Why the task rule was not enough
 *
 * Some clients never send us anything. We film them ourselves, or their whole
 * plan is posters and ads. Nothing on a *task* says so: a video for a client
 * who shoots nothing looks exactly like a video for one who does, so the chase
 * went out, monthly, to groups where the answer would always be "we don't do
 * that" — the kind of message that teaches a client to stop reading the group.
 *
 * So it is a switch on the client, and only these four callers ask it:
 *
 *   - the scheduled footage chase
 *   - the same chase sent by hand from Settings → Reminders
 *   - the group assistant, which would otherwise volunteer it in conversation
 *   - the summary the group is sent
 *
 * The agency's own boards, the client portal and the route that *accepts* a
 * link deliberately do not. Turning the chase off is a decision about what we
 * send them, not a claim that the footage is unnecessary — and a client who
 * sends a link anyway must still have it taken.
 */
import "server-only";
import { hasColumn } from "./db";
import { needsRawFootageSql } from "./raw-footage";

/**
 * SQL for "this piece is waiting on footage, and this client is one we ask".
 *
 * Drop-in for `needsRawFootageSql` at any call site that sends a message. The
 * client is reached by subquery rather than a join so the nine existing call
 * sites keep their shape — every one of them already has `client_id` on the
 * deliverable, and none of them would otherwise have `clients` in scope.
 *
 * Falls back to the task rule alone until the column has been applied, which
 * is the same thing it did before this existed.
 *
 * @param alias the `deliverables` alias, or "" when it is the only table.
 */
export async function footageChaseSql(alias = "d"): Promise<string> {
  const kind = needsRawFootageSql(alias);
  if (!(await hasColumn("clients", "provides_footage"))) return kind;
  const p = alias ? `${alias}.` : "";
  return `(${kind} AND COALESCE(
    (SELECT pf.provides_footage FROM clients pf WHERE pf.id = ${p}client_id), 1) = 1)`;
}
