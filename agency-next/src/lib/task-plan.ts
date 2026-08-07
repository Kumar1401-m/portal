/**
 * Filling a client's month from the numbers on their contract.
 *
 * A client record already says how much work is owed each month — Monthly
 * videos and Monthly posters — and until now that number only ever appeared on
 * a progress bar. Someone still had to type twelve tasks. This turns the
 * number into the tasks.
 *
 * Two rules shape everything below.
 *
 * It tops up rather than creates. The count is a target for the month, so what
 * gets generated is the shortfall — twelve owed and five already there means
 * seven new ones. Pressing the button twice is therefore harmless, which
 * matters because it is the kind of button people press again when they aren't
 * sure the first press worked.
 *
 * It generates placeholders, not briefs. Every task lands on the first of the
 * month with a plain numbered name, because the dates and the subjects are
 * decided by a person afterwards — that is what the date controls are for. The
 * point is to skip the typing, not to guess the plan.
 */
import "server-only";
import { query, queryOne, execute } from "./db";
import { getCategoryMap } from "./categories";
import { DEFAULT_CATEGORIES, videoTypeForService, type ServiceKey } from "./services";

/** Tasks a cancelled or rejected row shouldn't count towards. */
const COUNTS_TOWARDS_TARGET = "d.status NOT IN ('cancelled','rejected')";

/**
 * Poster or video, decided the same way the client board decides it, so the
 * tally the button reads matches the tally the progress bars show.
 */
const IS_POSTER = `(COALESCE(NULLIF(d.service,''),
  IF(LOWER(COALESCE(d.video_type,'')) = 'poster','poster_designing','video_editing')) = 'poster_designing')`;

export type MonthPlan = {
  month: string;
  videoTarget: number;
  posterTarget: number;
  videosExisting: number;
  postersExisting: number;
  /** The shortfall — what pressing Generate would actually create. */
  videosToAdd: number;
  postersToAdd: number;
};

export type GenerateResult = {
  month: string;
  videos: number;
  posters: number;
};

/** First day of a YYYY-MM month, as the date column wants it. */
export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

/** YYYY-MM, validated — anything else falls back to the current month. */
export function safeMonth(month: string | null | undefined): string {
  const m = String(month || "");
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return m;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * What a month owes and what it already has.
 *
 * Reads the targets off the client rather than taking them as arguments: the
 * contract is the source of truth, and a caller passing its own numbers is how
 * a generated month quietly stops matching the progress bar beside it.
 */
export async function monthPlan(clientId: number, month: string): Promise<MonthPlan | null> {
  const mk = safeMonth(month);
  const client = await queryOne<{ monthly_deliverables: number | null; monthly_posters: number | null }>(
    "SELECT monthly_deliverables, monthly_posters FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  const tally = await queryOne<{ videos: number; posters: number }>(
    `SELECT COALESCE(SUM(NOT ${IS_POSTER}),0) AS videos,
            COALESCE(SUM(${IS_POSTER}),0) AS posters
       FROM deliverables d
      WHERE d.client_id = ? AND d.month_key = ? AND ${COUNTS_TOWARDS_TARGET}`,
    [clientId, mk]
  );

  const videoTarget = Math.max(0, Number(client.monthly_deliverables) || 0);
  const posterTarget = Math.max(0, Number(client.monthly_posters) || 0);
  const videosExisting = Number(tally?.videos) || 0;
  const postersExisting = Number(tally?.posters) || 0;

  return {
    month: mk,
    videoTarget,
    posterTarget,
    videosExisting,
    postersExisting,
    videosToAdd: Math.max(0, videoTarget - videosExisting),
    postersToAdd: Math.max(0, posterTarget - postersExisting),
  };
}

/** The category a generated task gets: the client's first active one, or the built-in default. */
async function defaultCategory(service: ServiceKey): Promise<string> {
  const map = await getCategoryMap();
  return map[service]?.[0]?.name || DEFAULT_CATEGORIES[service][0] || "";
}

/**
 * Create the month's missing tasks.
 *
 * Numbered from what is already there — a client with five videos gets "Video
 * 6" upwards — so the names stay unique and reading the list tells you where
 * the month stands. They all share a due date on purpose; moving them is a
 * separate, deliberate step.
 */
export async function generateMonthTasks(
  clientId: number,
  month: string,
  createdBy: number
): Promise<GenerateResult> {
  const plan = await monthPlan(clientId, month);
  if (!plan) return { month: safeMonth(month), videos: 0, posters: 0 };

  const client = await queryOne<{ designer_id: number | null }>(
    "SELECT designer_id FROM clients WHERE id = ?",
    [clientId]
  );

  const due = firstOfMonth(plan.month);
  const rows: (string | number | null)[][] = [];

  // Numbering continues from the highest number already used, not from how
  // many tasks are there. Those differ the moment one is cancelled: eleven
  // live videos next to a "Video 12" would generate a second "Video 12", and
  // two tasks with one name is exactly the confusion the numbers exist to
  // prevent. Cancelled rows still hold their number for this reason.
  const used = await query<{ title: string }>(
    "SELECT title FROM deliverables WHERE client_id = ? AND month_key = ?",
    [clientId, plan.month]
  );
  const highest = (noun: string) => {
    const re = new RegExp(`^${noun} (\\d+)$`);
    return used.reduce((max, r) => {
      const m = re.exec(String(r.title || "").trim());
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  };

  const add = async (service: ServiceKey, count: number, startAt: number, noun: string) => {
    if (count <= 0) return;
    const category = await defaultCategory(service);
    const videoType = videoTypeForService(service, category);
    // The client's default designer stands in for poster work only — the same
    // rule the manual form follows, so generated tasks land where hand-made
    // ones would.
    const assignee = service === "poster_designing" ? (client?.designer_id ?? null) : null;
    for (let i = 0; i < count; i++) {
      rows.push([
        clientId,
        `${noun} ${startAt + i + 1}`,
        service,
        category,
        videoType,
        due,
        plan.month,
        createdBy,
        assignee,
      ]);
    }
  };

  await add("video_editing", plan.videosToAdd, highest("Video"), "Video");
  await add("poster_designing", plan.postersToAdd, highest("Poster"), "Poster");

  if (rows.length) {
    await execute(
      `INSERT INTO deliverables
         (client_id, title, service, content_category, video_type,
          due_date, month_key, created_by, assigned_to, platform, priority, status)
       VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?,?,'instagram','medium','pending')").join(",")}`,
      rows.flat()
    );
  }

  return { month: plan.month, videos: plan.videosToAdd, posters: plan.postersToAdd };
}

/**
 * Move every task in a month by a number of days.
 *
 * For the month that slips as a whole — a late start, a festival week — where
 * changing fifteen dates one at a time is the same decision typed fifteen
 * times.
 *
 * Work that is already out of the agency's hands is left where it is. A task
 * that has been posted has a date that is a record of what happened, and one
 * awaiting the client's approval has a date they have already been told; both
 * would be falsified by moving them, so the shift covers the tasks still on
 * the bench.
 *
 * `month_key` follows the new date, otherwise a task shifted out of its month
 * keeps counting towards the old month's target and the tallies drift.
 */
export async function shiftMonthDates(
  clientId: number,
  month: string,
  days: number
): Promise<number> {
  const mk = safeMonth(month);
  const by = Math.trunc(Number(days) || 0);
  if (!by || Math.abs(by) > 365) return 0;

  // month_key is assigned first on purpose. MySQL evaluates SET clauses left
  // to right and a later one sees the values already assigned, so computing
  // the month after moving the date would shift it a second time — a task
  // moved seven days would land in the month fourteen days away.
  const res = await execute(
    `UPDATE deliverables d
        SET d.month_key = DATE_FORMAT(DATE_ADD(d.due_date, INTERVAL ? DAY), '%Y-%m'),
            d.due_date  = DATE_ADD(d.due_date, INTERVAL ? DAY)
      WHERE d.client_id = ? AND d.month_key = ? AND d.due_date IS NOT NULL
        AND d.status IN ('pending','in_progress','content_review','changes_requested')`,
    [by, by, clientId, mk]
  );
  return res.affectedRows ?? 0;
}

/** Move one task, keeping its month in step with its new date. */
export async function setTaskDate(taskId: number, date: string | null): Promise<boolean> {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const res = await execute(
    `UPDATE deliverables
        SET due_date = ?, month_key = COALESCE(DATE_FORMAT(?, '%Y-%m'), month_key)
      WHERE id = ?`,
    [date, date, taskId]
  );
  return (res.affectedRows ?? 0) > 0;
}

/**
 * Fill the month for every active client at once.
 *
 * Generating on client creation only helps the clients added after it existed.
 * Everyone already on the books, and every month after the first, still needs
 * a person to ask — and asking client by client is the same tedium one level
 * up. This is the same top-up, run across the book.
 *
 * Churned clients are skipped: they are gone as far as the portal is
 * concerned, and generating work for them is how a removed client reappears
 * on the dashboard.
 *
 * One client failing does not stop the rest. A month half-filled is fixable
 * from the client's own page; a run that abandons the remaining clients
 * because the third one had a bad row is not obviously fixable at all.
 */
export async function generateForAllClients(
  month: string,
  createdBy: number
): Promise<{ month: string; clients: number; videos: number; posters: number; failed: number }> {
  const mk = safeMonth(month);
  const clients = await query<{ id: number }>(
    `SELECT id FROM clients
      WHERE status <> 'churned'
        AND (COALESCE(monthly_deliverables,0) > 0 OR COALESCE(monthly_posters,0) > 0)
      ORDER BY id`
  );

  let touched = 0, videos = 0, posters = 0, failed = 0;
  for (const c of clients) {
    try {
      const made = await generateMonthTasks(c.id, mk, createdBy);
      if (made.videos || made.posters) touched++;
      videos += made.videos;
      posters += made.posters;
    } catch {
      failed++;
    }
  }
  return { month: mk, clients: touched, videos, posters, failed };
}

/** What a run across the book would create, before anyone presses anything. */
export async function pendingAcrossClients(
  month: string
): Promise<{ clients: number; videos: number; posters: number }> {
  const mk = safeMonth(month);
  const clients = await query<{ id: number }>(
    `SELECT id FROM clients
      WHERE status <> 'churned'
        AND (COALESCE(monthly_deliverables,0) > 0 OR COALESCE(monthly_posters,0) > 0)`
  );
  let n = 0, videos = 0, posters = 0;
  for (const c of clients) {
    const p = await monthPlan(c.id, mk);
    if (!p) continue;
    if (p.videosToAdd || p.postersToAdd) n++;
    videos += p.videosToAdd;
    posters += p.postersToAdd;
  }
  return { clients: n, videos, posters };
}

export type PlannedTask = {
  id: number;
  title: string;
  status: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  due_date: string | null;
};

/**
 * One month's tasks, in the order they fall due.
 *
 * By date rather than by id, because the panel exists to arrange dates and a
 * list that doesn't reorder as you change them is no help in seeing whether
 * the month now looks right.
 */
export async function monthTasks(clientId: number, month: string): Promise<PlannedTask[]> {
  return query<PlannedTask>(
    `SELECT id, title, status, service, video_type, content_category, due_date
       FROM deliverables
      WHERE client_id = ? AND month_key = ?
      ORDER BY (due_date IS NULL), due_date ASC, id ASC
      LIMIT 100`,
    [clientId, safeMonth(month)]
  );
}

/** Months that already have tasks, newest first — for the month picker. */
export async function clientMonths(clientId: number): Promise<string[]> {
  const rows = await query<{ month_key: string }>(
    `SELECT DISTINCT month_key FROM deliverables
      WHERE client_id = ? AND month_key IS NOT NULL AND month_key <> ''
      ORDER BY month_key DESC LIMIT 24`,
    [clientId]
  );
  return rows.map((r) => r.month_key);
}
