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
 * It generates placeholders, not briefs. Every task gets a plain numbered
 * name, because the subject is decided by a person afterwards. The dates are
 * not left to them, though: the month is divided by how much goes in it, so a
 * client on ten videos gets one every three days and one on four gets one a
 * week, with posters falling between the videos rather than after all of them.
 * Every date is still movable from the plan.
 */
import "server-only";
import { onTheFloor } from "./client-status";
import { query, queryOne, execute } from "./db";
import { getCategoryMap } from "./categories";
import { DEFAULT_CATEGORIES, videoTypeForService, type ServiceKey } from "./services";
import { utcToLocalInput } from "./posting";
import { clientDefaults, defaultAssigneeFor } from "./clients";

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

/**
 * The day generated tasks are due: the first of the month, or today if that
 * month is already underway.
 *
 * Filling August on the seventh used to date all sixteen tasks the first —
 * born six days overdue, counted as late on the dashboard the instant they
 * were created, and sorted into history rather than onto Today's board, which
 * is where work created today belongs.
 *
 * Decided by the database rather than in JavaScript so that "today" means the
 * same thing here as it does in the `due_date <= CURDATE()` the Today board
 * filters on. A server an hour either side of the database's midnight would
 * otherwise generate tasks that disagree with the board about what day it is.
 *
 * Only the current month is clamped. A future month keeps its first, and a
 * past month is left alone entirely: dragging old tasks onto today would move
 * them out of the month their month_key says they belong to.
 */
const DUE_DATE_SQL = "IF(DATE_FORMAT(CURDATE(),'%Y-%m') = ?, GREATEST(?, CURDATE()), ?)";

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
 * the month stands. Spread evenly across what is left of the month, continuing
 * after whatever it already holds, and never past its last day.
 */
export async function generateMonthTasks(
  clientId: number,
  month: string,
  createdBy: number,
  /**
   * Exact counts, overriding the contract.
   *
   * Topping up to the monthly target is the common case and stays the
   * default. This is for the month that is not the contract — an extra push,
   * a campaign, a client who asked for three more.
   */
  exact?: { videos?: number; posters?: number }
): Promise<GenerateResult> {
  const plan = await monthPlan(clientId, month);
  if (!plan) return { month: safeMonth(month), videos: 0, posters: 0 };
  const wantVideos = exact?.videos ?? plan.videosToAdd;
  const wantPosters = exact?.posters ?? plan.postersToAdd;

  const client = await clientDefaults(clientId);

  const due = firstOfMonth(plan.month);

  /*
   * Where the spacing starts, and where it must stop.
   *
   * Both come from the database in one round trip: `DUE_DATE_SQL` so that
   * "today" means the same thing here as it does on the Today board, and
   * `LAST_DAY` so the run cannot walk out of the month it is filling.
   *
   * `after` is the last date already spoken for. Topping up continues from
   * there rather than restarting at the first — adding five to a month that
   * already runs 1st, 3rd, 5th should give the 7th onwards, not five more
   * tasks piled on the 1st.
   */
  const [bounds] = await query<{ base: string; last: string; after: string | null }>(
    `SELECT ${DUE_DATE_SQL} AS base,
            LAST_DAY(?) AS last,
            (SELECT MAX(due_date) FROM deliverables
              WHERE client_id = ? AND month_key = ? AND due_date IS NOT NULL) AS after`,
    [plan.month, due, due, due, clientId, plan.month]
  );

  const day = (s: string) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
  const asDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const DAY_MS = 86_400_000;

  const baseMs = day(bounds.base);
  const lastMs = day(bounds.last);
  const afterMs = bounds.after ? day(bounds.after) : null;

  /*
   * Where the new run starts.
   *
   * After whatever is already there, so topping up continues the month rather
   * than restarting it — but only while there is room left to continue into.
   *
   * There often is not. The old two-day spacing clamped any overflow onto the
   * month's last day, so a great many months already hold a task dated the
   * 31st; and a month generated in full has one by design. Starting after that
   * leaves a window of nothing, every new task rounds to the same date, and
   * ten videos land on one day — which is the bug this whole change was
   * supposed to fix, reappearing on the second press of the button.
   *
   * So the tail is used only if it can hold what is going into it. Otherwise
   * the run spreads across the whole of what is left of the month and shares
   * some days with the tasks already there. Two on a day is a real answer;
   * ten on one is not.
   */
  const totalToAdd = wantVideos + wantPosters;
  const tailMs = afterMs !== null ? Math.max(baseMs, afterMs + DAY_MS) : baseMs;
  const roomFor = (fromMs: number) => lastMs - fromMs >= Math.max(0, totalToAdd - 1) * DAY_MS;
  const startMs =
    totalToAdd <= 1
      ? // One extra piece added to a month belongs at the end of it, not back
        // at a first that has usually already passed.
        Math.min(tailMs, lastMs)
      : tailMs <= lastMs && roomFor(tailMs)
        ? tailMs
        : baseMs;

  /*
   * The month is divided by how much goes in it, not filled two days at a time.
   *
   * A fixed two-day gap ignores the one number that matters. Ten videos in a
   * thirty-day month came out on the 1st to the 19th and then stopped, and the
   * posters — added as a second run after the videos — landed on the 21st to
   * the 27th. So the client's month was front-loaded with video, tailed with
   * poster, and empty for the last few days. A client on four videos got the
   * opposite: everything done inside a week.
   *
   * Spreading by count fixes both. The window is whatever is left of the month
   * from today, the first task lands at the start of it and the last on the
   * final day, and everything in between is evenly spaced — so ten videos are
   * three days apart and four are ten, without anyone choosing a number.
   *
   * Rounded to whole days, which means a month with more tasks than days puts
   * two on some of them. That is the honest answer to "forty videos in
   * February"; the old code answered it by piling twenty on the 28th.
   */
  const slotDate = (i: number, total: number): string => {
    if (total <= 1) return asDate(Math.min(startMs, lastMs));
    const span = Math.max(0, lastMs - startMs);
    return asDate(Math.min(startMs + Math.round((i * span) / (total - 1)), lastMs));
  };

  /*
   * And the two kinds are interleaved rather than run one after the other.
   *
   * Whichever kind is furthest behind its own share goes next, so ten videos
   * and four posters come out roughly V V V P V V P V V P V V P V — the
   * posters sitting between the videos across the whole month, which is how a
   * feed is actually planned.
   */
  const interleave = (videos: number, posters: number): ServiceKey[] => {
    const out: ServiceKey[] = [];
    let v = 0;
    let p = 0;
    while (v < videos || p < posters) {
      const takeVideo =
        p >= posters || (v < videos && (v + 0.5) / videos <= (p + 0.5) / posters);
      if (takeVideo) {
        out.push("video_editing");
        v++;
      } else {
        out.push("poster_designing");
        p++;
      }
    }
    return out;
  };

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

  /*
   * One pass over the interleaved sequence, dated by position in it.
   *
   * It was two passes, one per kind, sharing a cursor — which is what put all
   * the videos before all the posters. The order is decided first now, and the
   * date falls out of where a task sits in it.
   */
  const sequence = interleave(wantVideos, wantPosters);
  const meta: Record<string, { noun: string; next: number; category: string; videoType: string | null; assignee: number | null }> = {
    video_editing: {
      noun: "Video",
      next: highest("Video"),
      category: await defaultCategory("video_editing"),
      videoType: null,
      // The same rule the manual form follows, so a generated task lands where
      // a hand-made one would.
      assignee: defaultAssigneeFor("video_editing", client),
    },
    poster_designing: {
      noun: "Poster",
      next: highest("Poster"),
      category: await defaultCategory("poster_designing"),
      videoType: null,
      assignee: defaultAssigneeFor("poster_designing", client),
    },
  };
  for (const key of Object.keys(meta)) {
    meta[key].videoType = videoTypeForService(key as ServiceKey, meta[key].category);
  }

  sequence.forEach((service, i) => {
    const m = meta[service];
    m.next += 1;
    rows.push([
      clientId,
      `${m.noun} ${m.next}`,
      service,
      m.category,
      m.videoType,
      slotDate(i, sequence.length),
      plan.month,
      createdBy,
      m.assignee,
    ]);
  });

  if (rows.length) {
    await execute(
      `INSERT INTO deliverables
         (client_id, title, service, content_category, video_type,
          due_date, month_key, created_by, assigned_to, platform, priority, status)
       VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?,?,'instagram','medium','pending')").join(",")}`,
      rows.flat()
    );
  }

  return { month: plan.month, videos: wantVideos, posters: wantPosters };
}

/**
 * Statuses a date change is allowed to touch.
 *
 * Approved and scheduled work is included, which it was not before. Moving a
 * date is how the agency says "this goes out later now", and refusing to move
 * the approved ones meant the only tasks with a real posting time were the
 * ones the button could not reach. The client is told either way — the
 * approval was for the content, not for the calendar.
 *
 * Posted work is the line. Its date is a record of something that happened,
 * and a record you can edit is not a record.
 */
const MOVABLE = [
  "pending",
  "in_progress",
  "content_review",
  "changes_requested",
  "waiting_for_raw",
  "raw_uploaded",
  "editing",
  "caption_ready",
  "review",
  "approved",
  "scheduled",
];

/**
 * Move the posting slot by the same number of days as the date.
 *
 * By a delta rather than by rebuilding the timestamp from the new date. The
 * slot is stored in UTC and the date is the day it goes out in the client's
 * own clock, and for anywhere far enough west those are different calendar
 * days — 7pm in New York is midnight UTC the following day. Rebuilding would
 * quietly pull those posts a day early; adding the same number of days cannot,
 * whatever the timezone, and it keeps the exact hour that was chosen.
 *
 * NULL stays NULL: a task with no posting time is not scheduled, and inventing
 * one here would queue something nobody asked to be queued.
 */
const SHIFT_SCHEDULED = "DATE_ADD(d.scheduled_at, INTERVAL ? DAY)";

/**
 * Move every task in a month by a number of days.
 *
 * For the month that slips as a whole — a late start, a festival week — where
 * changing fifteen dates one at a time is the same decision typed fifteen
 * times.
 *
 * `month_key` follows the new date, otherwise a task shifted out of its month
 * keeps counting towards the old month's target and the tallies drift. So does
 * `scheduled_at`, or the video still posts on the day it was originally going
 * to and the move only appears to have worked.
 */
export async function shiftMonthDates(
  clientId: number,
  month: string,
  days: number
): Promise<number> {
  const mk = safeMonth(month);
  const by = Math.trunc(Number(days) || 0);
  if (!by || Math.abs(by) > 365) return 0;

  // month_key and scheduled_at are assigned before due_date on purpose. MySQL
  // evaluates SET clauses left to right and a later one sees the values
  // already assigned, so computing either from due_date after moving it would
  // shift it a second time — a task moved seven days would land fourteen away.
  const res = await execute(
    `UPDATE deliverables d
        SET d.month_key    = DATE_FORMAT(DATE_ADD(d.due_date, INTERVAL ? DAY), '%Y-%m'),
            d.scheduled_at = ${SHIFT_SCHEDULED},
            d.due_date     = DATE_ADD(d.due_date, INTERVAL ? DAY)
      WHERE d.client_id = ? AND d.month_key = ? AND d.due_date IS NOT NULL
        AND d.status IN (${MOVABLE.map(() => "?").join(",")})
        AND COALESCE(d.instagram_status, '') <> 'posted'`,
    [by, by, by, clientId, mk, ...MOVABLE]
  );
  return res.affectedRows ?? 0;
}

/**
 * Move one task to a day, and make that day the day it posts.
 *
 * The picked date is treated as an instruction about *the posting day*, not as
 * an offset. Shifting `scheduled_at` by `DATEDIFF(picked, due_date)` was only
 * right while the two agreed — and they had already drifted apart on live
 * data, because until today moving a date never touched the slot at all. On
 * such a row a relative shift preserves the drift for ever: pick the 11th on a
 * task whose slot is the 10th and you get the 12th.
 *
 * So the delta is measured from where the post is actually going out, in the
 * client's own clock, which makes the picked day exactly right whatever the
 * row started as. Any existing divergence is corrected the first time someone
 * touches the date.
 *
 * Still a whole number of days added to the stored instant, never a rebuilt
 * timestamp: that keeps the evening hour somebody chose and stays correct for
 * a client whose local evening falls on the next UTC day.
 */
export async function setTaskDate(taskId: number, date: string | null): Promise<boolean> {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const row = await queryOne<{
    scheduled_at: string | null;
    country: string | null;
  }>(
    `SELECT d.scheduled_at,
            JSON_UNQUOTE(JSON_EXTRACT(c.placeholder_values, '$.country')) AS country
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [taskId]
  );

  // Where the slot moves to, worked out here rather than in SQL so the
  // timezone conversion is the same one the rest of the portal uses.
  let scheduledAt: string | null | undefined; // undefined = leave it alone
  if (date && row?.scheduled_at) {
    const from = postingDay(row.scheduled_at, row.country);
    const shiftDays = from ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) : 0;
    scheduledAt = shiftDays
      ? new Date(Date.parse(`${row.scheduled_at.replace(" ", "T")}Z`) + shiftDays * 86_400_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ")
      : row.scheduled_at;
  }

  const res = await execute(
    `UPDATE deliverables
        SET month_key    = COALESCE(DATE_FORMAT(?, '%Y-%m'), month_key),
            due_date     = ?,
            scheduled_at = COALESCE(?, scheduled_at)
      WHERE id = ? AND COALESCE(instagram_status, '') <> 'posted'`,
    [date, date, scheduledAt ?? null, taskId]
  );
  return (res.affectedRows ?? 0) > 0;
}

/**
 * Spread a month's existing tasks across what is left of it.
 *
 * Generating spreads new tasks out; this is for the months that were filled
 * before it did, where twelve videos all sit on the 1st. Same rule, same
 * start, applied to what is already there — dividing the window by the number
 * of tasks rather than stepping through it two days at a time, so a light
 * month is spread wide and a heavy one is not all crammed into its first
 * fortnight.
 *
 * Each move goes through `setTaskDate`, so a task's posting slot follows its
 * date exactly as it does when the date is changed by hand — the day it lands
 * on is the day it goes out. Writing a second, faster loop here would be a
 * second definition of what moving a date means.
 *
 * Order is preserved: whatever sequence the month is already in stays, so a
 * plan somebody has read does not come back reshuffled. Posted work keeps its
 * date and is skipped — that date is a record of something that happened.
 */
export async function respaceMonth(
  clientId: number,
  month: string
): Promise<{ moved: number; skipped: number; from: string | null; to: string | null }> {
  const mk = safeMonth(month);
  const due = firstOfMonth(mk);

  const [bounds] = await query<{ base: string; last: string }>(
    `SELECT ${DUE_DATE_SQL} AS base, LAST_DAY(?) AS last`,
    [mk, due, due, due]
  );

  const tasks = await query<{ id: number }>(
    `SELECT d.id FROM deliverables d
      WHERE d.client_id = ? AND d.month_key = ?
        AND d.status IN (${MOVABLE.map(() => "?").join(",")})
        AND COALESCE(d.instagram_status,'') <> 'posted'
      ORDER BY d.due_date IS NULL, d.due_date ASC, d.id ASC`,
    [clientId, mk, ...MOVABLE]
  );
  if (!tasks.length) return { moved: 0, skipped: 0, from: null, to: null };

  const baseMs = Date.parse(`${String(bounds.base).slice(0, 10)}T00:00:00Z`);
  const lastMs = Date.parse(`${String(bounds.last).slice(0, 10)}T00:00:00Z`);

  let moved = 0;
  let skipped = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  // The same division generating uses. Clamped to the month's last day for
  // the same reason: a task dated outside its own month_key is counted by one
  // month and shown in another's calendar.
  const span = Math.max(0, lastMs - baseMs);
  for (let i = 0; i < tasks.length; i++) {
    const at =
      tasks.length <= 1
        ? Math.min(baseMs, lastMs)
        : Math.min(baseMs + Math.round((i * span) / (tasks.length - 1)), lastMs);
    const date = new Date(at).toISOString().slice(0, 10);
    if (await setTaskDate(tasks[i].id, date)) {
      moved++;
      firstDate ??= date;
      lastDate = date;
    } else {
      skipped++;
    }
  }

  return { moved, skipped, from: firstDate, to: lastDate };
}

export type SyncResult = {
  month: string;
  added: { videos: number; posters: number };
  removed: { videos: number; posters: number };
  /** Wanted gone but kept, because work had already started on them. */
  blocked: number;
};

/**
 * Make this month's tasks match the client's contract, both ways.
 *
 * Changing "Monthly videos" from twelve to twenty used to change one number
 * and nothing else: the target moved, the month still held twelve tasks, and
 * someone had to remember to press Generate. Going the other way was worse —
 * dropping to eight left twelve on the board with no way to trim them except
 * deleting each by hand, and every count downstream kept measuring against a
 * contract that no longer existed.
 *
 * So the contract is treated as what it is: the number of pieces this month
 * owes. Raise it and the shortfall appears; lower it and the surplus goes.
 *
 * Only the current month. A past month is a record of what was delivered, and
 * a future one may have been laid out deliberately — neither should be rewritten
 * because a contract changed today.
 *
 * Removal only ever takes untouched placeholders, newest first (`removeTasks`
 * enforces it). A task somebody has filmed, edited or sent to a client is not
 * surplus, whatever the contract now says, and `blocked` reports how many were
 * kept so the caller can say so rather than silently doing less than asked.
 */
export async function syncMonthToTarget(
  clientId: number,
  month: string,
  createdBy: number
): Promise<SyncResult> {
  const mk = safeMonth(month);
  const out: SyncResult = {
    month: mk,
    added: { videos: 0, posters: 0 },
    removed: { videos: 0, posters: 0 },
    blocked: 0,
  };

  const plan = await monthPlan(clientId, mk);
  if (!plan) return out;

  // Short: create the difference. `generateMonthTasks` tops up to the target
  // on its own, so it is handed the same shortfall it would work out anyway.
  if (plan.videosToAdd > 0 || plan.postersToAdd > 0) {
    const made = await generateMonthTasks(clientId, mk, createdBy, {
      videos: plan.videosToAdd,
      posters: plan.postersToAdd,
    });
    out.added = { videos: made.videos, posters: made.posters };
  }

  // Over: give back what nobody has touched.
  const surplus = (existing: number, target: number) => Math.max(0, existing - target);
  const extraVideos = surplus(plan.videosExisting, plan.videoTarget);
  const extraPosters = surplus(plan.postersExisting, plan.posterTarget);

  if (extraVideos > 0) {
    const r = await removeTasks(clientId, mk, "video", extraVideos);
    out.removed.videos = r.removed;
    out.blocked += r.blocked;
  }
  if (extraPosters > 0) {
    const r = await removeTasks(clientId, mk, "poster", extraPosters);
    out.removed.posters = r.removed;
    out.blocked += r.blocked;
  }

  return out;
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
      WHERE ${onTheFloor("")}
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
      WHERE ${onTheFloor("")}
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

/**
 * Remove tasks from a month that nobody has started.
 *
 * Only untouched placeholders go: still pending, no footage, no video, no
 * caption, never sent to the client. A task with any of those has had work or
 * a client's attention put into it, and deleting it silently because someone
 * typed a number is not a thing this should be able to do — it refuses and
 * says how many it could actually take.
 *
 * Newest first, so removing three from a month of twelve leaves 1–9 rather
 * than a gap in the middle.
 */
export async function removeTasks(
  clientId: number,
  month: string,
  kind: "video" | "poster",
  count: number,
  /**
   * Take started work too, when someone has said so explicitly.
   *
   * The default refusal is right for the automatic paths — a contract change
   * must never quietly destroy an edit. But a month can end up genuinely
   * over-committed with every surplus task already captioned or sent, and then
   * refusing leaves the only route as deleting them one at a time from the
   * board. This is the same decision, made once, by a super admin who has been
   * told what it will delete.
   *
   * Posted work is still never touched, whatever this says: its record carries
   * the permalink and the date something went live on a client's account.
   */
  opts: { includeStarted?: boolean } = {}
): Promise<{ removed: number; blocked: number; startedRemoved: number }> {
  const mk = safeMonth(month);
  const want = Math.max(0, Math.trunc(Number(count) || 0));
  if (!want) return { removed: 0, blocked: 0, startedRemoved: 0 };

  const isPoster = kind === "poster";
  const rows = await query<{ id: number; untouched: number }>(
    `SELECT d.id,
            (d.status = 'pending'
             AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')
             AND (d.edited_link IS NULL OR d.edited_link = '')
             AND (d.caption IS NULL OR d.caption = '')
             AND COALESCE(d.wa_status,'not_sent') = 'not_sent') AS untouched
       FROM deliverables d
      WHERE d.client_id = ? AND d.month_key = ?
        AND ${isPoster ? IS_POSTER : `NOT ${IS_POSTER}`}
        -- Never a video that went out. Deleting that row loses the permalink
        -- and the date it was published, which is a record, not a task.
        AND d.status NOT IN ('posted','completed')
        AND COALESCE(d.instagram_status,'') <> 'posted'
      ORDER BY d.id DESC`,
    [clientId, mk]
  );

  /*
   * Untouched ones first, then started ones if allowed.
   *
   * Order matters even when everything is permitted: removing five from a
   * month should cost the five least-progressed tasks, not the five newest
   * regardless of how much work is in them.
   */
  const untouched = rows.filter((r) => Number(r.untouched) === 1).map((r) => r.id);
  const started = opts.includeStarted
    ? rows.filter((r) => Number(r.untouched) !== 1).map((r) => r.id)
    : [];

  const ids = [...untouched, ...started].slice(0, want);
  const startedTaken = ids.filter((id) => started.includes(id)).length;
  if (!ids.length) return { removed: 0, blocked: want, startedRemoved: 0 };

  const list = ids.join(",");
  // The same orphan-prone tables the bulk clear handles: no foreign key on two
  // of them, ON DELETE SET NULL on the rest, so a plain delete leaves rows
  // pointing at ids that are gone.
  for (const t of ["whatsapp_messages", "whatsapp_send_log", "captions", "scripts", "thumbnails", "post_insights"]) {
    try {
      await execute(`DELETE FROM ${t} WHERE deliverable_id IN (${list})`);
    } catch {
      /* a table this install never created */
    }
  }
  const res = await execute(`DELETE FROM deliverables WHERE id IN (${list})`);
  const removed = res.affectedRows ?? 0;
  return {
    removed,
    blocked: Math.max(0, want - removed),
    startedRemoved: Math.min(startedTaken, removed),
  };
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
/**
 * The month's tasks, each showing the day it actually goes out.
 *
 * `due_date` alone was wrong here, and produced the worst kind of wrong: the
 * Tasks board shows `scheduled_at ?? due_date`, so the same video appeared on
 * two screens under two different dates with nothing to explain it. Whichever
 * one you happened to be looking at, you were reading a real column — they
 * were simply different columns.
 *
 * The posting slot wins, because it is the one that decides when the client's
 * audience sees it. Converted to the client's own day: the slot is stored in
 * UTC and a picker showing a UTC date would be a third answer.
 */
export async function monthTasks(clientId: number, month: string): Promise<PlannedTask[]> {
  const rows = await query<PlannedTask & { scheduled_at: string | null; country: string | null }>(
    `SELECT d.id, d.title, d.status, d.service, d.video_type, d.content_category,
            d.due_date, d.scheduled_at,
            JSON_UNQUOTE(JSON_EXTRACT(c.placeholder_values, '$.country')) AS country
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.client_id = ? AND d.month_key = ?
      ORDER BY (COALESCE(d.scheduled_at, d.due_date) IS NULL),
               COALESCE(d.scheduled_at, d.due_date) ASC, d.id ASC
      LIMIT 100`,
    [clientId, safeMonth(month)]
  );

  return rows.map(({ scheduled_at, country, ...t }) => ({
    ...t,
    due_date: postingDay(scheduled_at, country) ?? t.due_date,
  }));
}

/** The local day a UTC posting slot falls on, as YYYY-MM-DD. */
function postingDay(scheduledAt: string | null, country: string | null): string | null {
  if (!scheduledAt) return null;
  const local = utcToLocalInput(scheduledAt, country);
  return local ? local.slice(0, 10) : null;
}

