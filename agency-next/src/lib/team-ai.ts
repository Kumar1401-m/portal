/**
 * Who should take this, and will it be done in time.
 *
 * Two questions that are really one: both are answered by what each person
 * already has on their plate and how fast they have historically got that kind
 * of work out. So both are computed here from the task board, and neither goes
 * anywhere near a model — a recommendation about a colleague's workload has to
 * be defensible to that colleague, and "the AI said so" is not defensible.
 *
 * **Only work, never people.** The signals are current queue, stated daily
 * capacity, and past turnaround on this category of task. Nothing about who
 * somebody is enters into it, and nothing should: an assignment engine that
 * learns from anything else learns the team's existing biases and then
 * enforces them at speed.
 *
 * Reads `users.daily_target`, which the Team page already sets, and the same
 * "moved forward" statuses `effectiveness.ts` counts — so the two screens
 * cannot disagree about who delivered what.
 */
import "server-only";
import { query, queryOne, hasColumn } from "./db";
import { ASSIGNABLE_ROLES, sqlRoleList } from "./roles";
import { serviceOf, type ServiceKey } from "./services";

/** The statuses that mean a person's own part is finished. Matches effectiveness.ts. */
const DELIVERED =
  "('caption_ready','review','approved','scheduled','posted','completed','resolved')";

/** Still on somebody's plate. */
const OPEN = "('pending','waiting_for_raw','raw_uploaded','editing','changes_requested')";

export type Member = {
  id: number;
  name: string;
  role: string;
  /** Their stated output per day. 0 means nobody has set one. */
  capacityPerDay: number;
  /** Tasks assigned and not finished. */
  open: number;
  /** Of those, how many are already past their date. */
  overdue: number;
  /** Days of work in front of them, at their own stated pace. Null with no capacity. */
  daysOfWork: number | null;
  /** Median days from assignment to delivery, last 90 days. Null with too few. */
  typicalDays: number | null;
  /** How many finished tasks that median rests on. */
  sample: number;
};

const num = (v: unknown) => Number(v ?? 0);

/**
 * Everyone work can be given to, with what they are carrying.
 *
 * One query for the queue and one for the history, rather than a query per
 * person: a team of twelve would otherwise be twenty-four round trips to draw
 * one panel.
 */
export async function workload(): Promise<Member[]> {
  if (!(await hasColumn("users", "daily_target"))) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT u.id, u.name, u.role, u.daily_target,
            COALESCE(SUM(d.status IN ${OPEN}), 0) AS open_count,
            COALESCE(SUM(d.status IN ${OPEN} AND d.due_date < CURDATE()), 0) AS overdue
       FROM users u
       LEFT JOIN deliverables d ON d.assigned_to = u.id
      WHERE u.is_active = 1 AND u.role IN (${sqlRoleList(ASSIGNABLE_ROLES)})
      GROUP BY u.id, u.name, u.role, u.daily_target
      ORDER BY u.name`
  ).catch(() => []);

  /*
   * How long each person's finished work has taken lately.
   *
   * Created to delivered, which overstates it — a task can sit unassigned for
   * a week before anybody starts — but it is the only span the schema records
   * end to end, and it is consistent per person, which is what a comparison
   * needs. Said plainly on the page rather than implied away.
   */
  const spans = await query<Record<string, unknown>>(
    `SELECT assigned_to AS id, DATEDIFF(updated_at, created_at) AS days
       FROM deliverables
      WHERE assigned_to IS NOT NULL
        AND status IN ${DELIVERED}
        AND updated_at >= CURDATE() - INTERVAL 90 DAY
        AND DATEDIFF(updated_at, created_at) BETWEEN 0 AND 60`
  ).catch(() => []);

  const byPerson = new Map<number, number[]>();
  for (const s of spans) {
    const id = num(s.id);
    byPerson.set(id, [...(byPerson.get(id) ?? []), num(s.days)]);
  }

  return rows.map((r) => {
    const id = num(r.id);
    const capacityPerDay = num(r.daily_target);
    const open = num(r.open_count);
    const list = (byPerson.get(id) ?? []).sort((a, b) => a - b);
    return {
      id,
      name: String(r.name),
      role: String(r.role),
      capacityPerDay,
      open,
      overdue: num(r.overdue),
      daysOfWork: capacityPerDay > 0 ? Math.round((open / capacityPerDay) * 10) / 10 : null,
      // Median, not mean: one task that sat over a holiday should not decide
      // what somebody's normal turnaround looks like.
      typicalDays: list.length >= 3 ? list[Math.floor(list.length / 2)] : null,
      sample: list.length,
    };
  });
}

export type Candidate = {
  member: Member;
  /** 0–100. Higher is a better fit for this particular task. */
  fit: number;
  reasons: string[];
};

/**
 * Who should get this task.
 *
 * Capacity headroom first, track record second. A person who is faster but
 * already two days underwater is the wrong answer — the work will not start
 * for two days however fast they are once it does.
 *
 * Nobody is scored against a capacity they were never given: a person with no
 * daily target set is ranked on queue length alone and said to be unrated,
 * rather than being quietly penalised for something an admin forgot.
 */
export function rankAssignees(members: Member[], role: string | null): Candidate[] {
  const eligible = role ? members.filter((m) => m.role === role) : members;
  if (!eligible.length) return [];

  const loads = eligible.map((m) => m.daysOfWork).filter((d): d is number => d !== null);
  const worstLoad = Math.max(1, ...loads);
  const speeds = eligible.map((m) => m.typicalDays).filter((d): d is number => d !== null);
  const slowest = Math.max(1, ...speeds);

  return eligible
    .map((m) => {
      const reasons: string[] = [];
      let fit = 50;

      if (m.daysOfWork !== null) {
        // Free is 100% of the load points, drowning is none.
        const headroom = 1 - m.daysOfWork / worstLoad;
        fit += Math.round(headroom * 35);
        reasons.push(
          m.open === 0
            ? "Nothing open right now"
            : `${m.open} open — about ${m.daysOfWork} day${m.daysOfWork === 1 ? "" : "s"} of work at their own pace`
        );
      } else {
        reasons.push(`${m.open} open, no daily target set`);
      }

      if (m.typicalDays !== null) {
        fit += Math.round((1 - m.typicalDays / slowest) * 15);
        reasons.push(`Usually turns work round in ${m.typicalDays} days (${m.sample} tasks)`);
      } else {
        reasons.push("Not enough finished work to judge their pace");
      }

      // Somebody already missing dates should not be handed more, whatever
      // their average says.
      if (m.overdue > 0) {
        fit -= Math.min(25, m.overdue * 6);
        reasons.push(`${m.overdue} already overdue`);
      }

      return { member: m, fit: Math.max(0, Math.min(100, fit)), reasons };
    })
    .sort((a, b) => b.fit - a.fit);
}

/** Which role does this kind of work — a poster to a designer, a video to an editor. */
export function roleForTask(input: { service?: string | null; video_type?: string | null }): string | null {
  const service: ServiceKey = serviceOf(input);
  if (service === "poster_designing") return "poster_designer";
  if (service === "video_editing") return "video_editor";
  return null;
}

export type DeadlineRisk = {
  /** 0–100 — the chance this misses its date, as a percentage. */
  risk: number;
  band: "safe" | "tight" | "likely_late" | "overdue";
  reasons: string[];
  recommendation: string;
};

/**
 * Will this be done in time?
 *
 * Days available against the queue in front of it plus how long this person's
 * work usually takes. Deliberately crude, and honest about being crude: the
 * question a producer asks on a Wednesday is "is Friday realistic", and a
 * rough yes-or-no with its workings shown beats a precise number derived from
 * a model that has never met the team.
 *
 * Returns 100 for something already past its date — that is not a prediction.
 */
export function deadlineRisk(input: {
  dueDate: string | null;
  today: string;
  assignee: Member | null;
  /** Where this task sits in their queue, oldest first. 0 means next up. */
  aheadInQueue: number;
}): DeadlineRisk {
  const reasons: string[] = [];

  if (!input.dueDate) {
    return {
      risk: 0,
      band: "safe",
      reasons: ["No due date set"],
      recommendation: "Give it a date — work without one is what slips first.",
    };
  }

  const days = Math.round(
    (Date.parse(`${input.dueDate.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${input.today.slice(0, 10)}T00:00:00Z`)) /
      86_400_000
  );

  if (days < 0) {
    return {
      risk: 100,
      band: "overdue",
      reasons: [`Due ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`],
      recommendation: "Already late — move the date or move the task to somebody free.",
    };
  }

  if (!input.assignee) {
    return {
      risk: 70,
      band: "likely_late",
      reasons: [`Due in ${days} day${days === 1 ? "" : "s"}`, "Nobody is assigned"],
      recommendation: "Assign it. An unassigned task with a date is a date nobody owns.",
    };
  }

  const m = input.assignee;
  reasons.push(`Due in ${days} day${days === 1 ? "" : "s"}`);

  // How long before they can even start it, at their own stated pace.
  const waitDays = m.capacityPerDay > 0 ? input.aheadInQueue / m.capacityPerDay : input.aheadInQueue;
  if (input.aheadInQueue > 0) {
    reasons.push(
      `${input.aheadInQueue} task${input.aheadInQueue === 1 ? "" : "s"} ahead of it in ${m.name}'s queue` +
        (m.capacityPerDay > 0 ? ` — about ${Math.round(waitDays * 10) / 10} days` : "")
    );
  }

  const doing = m.typicalDays ?? 2;
  if (m.typicalDays !== null) reasons.push(`${m.name} usually takes ${m.typicalDays} days on a task`);
  else reasons.push(`No track record for ${m.name} yet — assuming ${doing} days`);

  const needed = waitDays + doing;
  // Ratio of what it needs to what it has. 1.0 is exactly on the wire.
  const pressure = needed / Math.max(0.5, days);
  const risk = Math.max(0, Math.min(95, Math.round((pressure - 0.6) * 90)));

  const band: DeadlineRisk["band"] = risk >= 65 ? "likely_late" : risk >= 35 ? "tight" : "safe";

  return {
    risk,
    band,
    reasons,
    recommendation:
      band === "likely_late"
        ? `Needs about ${Math.round(needed)} days and has ${days}. Move it to somebody freer, or move the date now rather than on the day.`
        : band === "tight"
          ? "It fits, with nothing to spare. Worth checking in mid-week."
          : "Comfortable.",
  };
}

/** How many of this person's open tasks are due before the given one. */
export async function queuePosition(assigneeId: number, dueDate: string | null): Promise<number> {
  if (!dueDate) return 0;
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliverables
      WHERE assigned_to = ? AND status IN ${OPEN}
        AND due_date IS NOT NULL AND due_date < ?`,
    [assigneeId, dueDate]
  ).catch(() => null);
  return num(r?.n);
}

/** The database's today, so every date decision is made on one clock. */
export async function dbToday(): Promise<string> {
  const r = await queryOne<{ today: string }>(
    "SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today"
  ).catch(() => null);
  return r?.today ?? new Date().toISOString().slice(0, 10);
}
