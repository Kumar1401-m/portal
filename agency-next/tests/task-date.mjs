/**
 * Moving a task's date, from wherever the task is.
 *
 * There was one way to do it and it was inside the client: open the client,
 * find the month, find the row. Every other board in the portal showed the
 * date and offered nothing to do about it — for the change that is made most
 * often, because dates slip by a day constantly.
 *
 * ## And one meaning of "moved"
 *
 * A task carries two dates. `due_date` is the day it belongs to and what every
 * board sorts on; `scheduled_at` is the evening it actually posts. The client
 * board wrote the first and left the second, so a task dragged from Tuesday to
 * Thursday still had its posting slot on Tuesday evening — the board and the
 * publisher disagreeing about the day, with nothing on screen to say so.
 *
 * `setTaskDate` moves both, and now every path goes through it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const plan = await import(pathToFileURL(`${SRC}/lib/task-plan.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ date%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ date%'");
};

/* ------------------------------------------------------------------ *
 * Both dates move, and by the same number of days
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = Number(
    (
      await db.execute(
        `INSERT INTO clients (company_name, status, placeholder_values)
         VALUES ('ZZ date client', 'active', ?)`,
        [JSON.stringify({ country: "India" })]
      )
    ).insertId
  );
  // 5 PM IST on the 10th, which is 11:30 the same day in UTC.
  const did = Number(
    (
      await db.execute(
        `INSERT INTO deliverables (client_id, title, status, due_date, month_key, scheduled_at)
         VALUES (?, 'ZZ date reel', 'scheduled', '2030-03-10', '2030-03', '2030-03-10 11:30:00')`,
        [cid]
      )
    ).insertId
  );

  try {
    assert.equal(await plan.setTaskDate(did, "2030-03-13"), true, "the move is accepted");
    const row = await db.queryOne(
      "SELECT due_date, month_key, scheduled_at FROM deliverables WHERE id = ?",
      [did]
    );
    assert.equal(String(row.due_date).slice(0, 10), "2030-03-13", "the due date is the new day");
    assert.equal(
      String(row.scheduled_at).slice(0, 19).replace("T", " "),
      "2030-03-13 11:30:00",
      "and the posting slot moved with it, keeping its hour"
    );

    /*
     * The month a task counts towards follows its date, or the scorecard goes
     * on reporting it in the month it was moved out of.
     */
    assert.equal(await plan.setTaskDate(did, "2030-04-02"), true);
    const moved = await db.queryOne("SELECT month_key FROM deliverables WHERE id = ?", [did]);
    assert.equal(moved.month_key, "2030-04", "and a move across a month boundary re-files it");
    ok("moving a task moves the day it belongs to and the evening it goes out");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * A task not yet scheduled still posts on the day it is down for
 * ------------------------------------------------------------------ */
{
  /*
   * The half that was missing, and the one nothing on screen reconciled.
   *
   * A task carries a date long before it carries a posting slot — the slot is
   * written when it is approved. Scheduling asked "when is this client's next
   * evening?", counting from now, so a reel dated the 26th and approved on the
   * 20th went out on the 20th. The calendar on the row said the 26th and the
   * post did not, and both were displayed without contradiction.
   */
  await clean();
  const cid = Number(
    (
      await db.execute(
        `INSERT INTO clients (company_name, status, auto_publish, ig_user_id, placeholder_values)
         VALUES ('ZZ date client', 'active', 1, '17841400000000000', ?)`,
        [JSON.stringify({ country: "India" })]
      )
    ).insertId
  );
  // Well ahead, so the test does not depend on the day it is run.
  const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const did = Number(
    (
      await db.execute(
        `INSERT INTO deliverables (client_id, title, status, content_category, service, edited_link, due_date, scheduled_at)
         VALUES (?, 'ZZ date future reel', 'review', 'Instagram Reel', 'video_editing',
                 'https://example.com/zz.mp4', ?, NULL)`,
        [cid, day]
      )
    ).insertId
  );

  try {
    const out = await ig.approvalHandoff(did);
    assert.equal(out.status, "scheduled", "approving schedules it");
    assert.equal(
      String(out.scheduled_at).slice(0, 10),
      // India posts 5 PM IST, which is 11:30 the same day in UTC — so the
      // stored date is the same calendar day the row is down for.
      day,
      "on the day the calendar says, not the day it was approved"
    );

    /*
     * A day that has already gone is not a slot. Writing one schedules the
     * post for never: the queue wants a time that has arrived and is still
     * inside its window, and a date last week fails the second on sight.
     */
    await db.execute("UPDATE deliverables SET due_date = '2020-01-01' WHERE id = ?", [did]);
    await db.execute("UPDATE deliverables SET scheduled_at = NULL, instagram_status = 'not_posted' WHERE id = ?", [did]);
    const past = await ig.approvalHandoff(did);
    assert.ok(
      new Date(String(past.scheduled_at).replace(" ", "T") + "Z").getTime() > Date.now(),
      "a due date in the past falls back to the next slot rather than scheduling backwards"
    );
    ok("the day on the calendar is the day it posts, unless that day has gone");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Every path goes through the one function
 * ------------------------------------------------------------------ */
{
  const board = read("app/(app)/deliverables/client-board-actions.ts");
  assert.ok(board.includes("await setTaskDate(id, dueDate);"), "the client board moves it there");
  assert.ok(
    !board.includes('"UPDATE deliverables SET due_date = ?, month_key = ?, assigned_to = ? WHERE id = ?"'),
    "and no longer writes the date columns itself"
  );

  const action = read("app/(app)/deliverables/task-date-actions.ts");
  assert.ok(action.includes("await setTaskDate(taskId, raw || null)"), "so does the row control");

  /*
   * And it is scoped by the task, not by a client id in the form. The old
   * action took `client_id` and checked access against that, which is only
   * possible on a page that is already about one client — the reason this
   * lived in one place.
   */
  assert.ok(
    action.includes('"SELECT client_id FROM deliverables WHERE id = ?"'),
    "reading the client off the task"
  );
  assert.ok(action.includes("canAccessClient(user, d.client_id)"), "and checking access against it");
  assert.ok(
    !read("app/(app)/clients/[id]/plan-actions.ts").includes("setTaskDateAction"),
    "the client-scoped copy is gone rather than left beside it"
  );
  ok("one definition of moving a date, and it does not need a client page");
}

/* ------------------------------------------------------------------ *
 * It is beside the pencil, on every board that has one
 * ------------------------------------------------------------------ */
{
  for (const p of [
    "app/(app)/deliverables/page.tsx",
    "app/(app)/today/page.tsx",
    "app/(app)/reports/[id]/page.tsx",
    "app/(app)/clients/[id]/monthly-plan.tsx",
  ]) {
    const s = read(p);
    assert.ok(s.includes("<TaskDate "), `${p} shows the date control`);
  }

  /*
   * The same component in all four, not four copies. The plan had its own,
   * which is how it came to be the only one that worked.
   */
  const control = read("app/(app)/deliverables/task-date.tsx");
  assert.ok(control.includes("moveTaskDateAction"), "all of them through the one action");
  assert.ok(
    control.includes("form.current?.requestSubmit()"),
    "and saving on the pick rather than behind a per-row button"
  );

  /*
   * On a board it is the calendar icon and nothing else.
   *
   * It went out as the full field — a button wide enough to read "26 Aug 2026"
   * off — dropped into an actions column twenty units wide and shared with a
   * pencil. It rendered as "26" with the rest cut off: a control showing a
   * fragment of a date, unreadable, beside a Schedule date column already
   * printing the whole thing.
   */
  assert.ok(control.includes("compact = true"), "the board default is the icon alone");
  assert.ok(
    read("app/(app)/clients/[id]/monthly-plan.tsx").includes("compact={false}"),
    "and the plan, where the date is read rather than only changed, keeps the full field"
  );

  /*
   * And the panel hangs from the right edge there. It is 17.5rem wide in the
   * last column of a table: anchored left it opens off the side of the page,
   * which on a phone means no calendar at all.
   */
  assert.ok(control.includes('align={compact ? "right" : "left"}'), "opening inward, not off-screen");

  /*
   * And the calendar escapes the cell it is opened from.
   *
   * As an `absolute` child it was cropped to nothing: a dense table gives
   * every `td` `overflow-hidden` — `table-fixed` needs it so a long value is
   * clipped rather than widening its column — inside an `overflow-x-auto`
   * wrapper. The picker opened and there was nothing on screen, which is
   * indistinguishable from a button that does not work.
   */
  const field = read("components/ui/date-field.tsx");
  assert.ok(field.includes("createPortal("), "the panel is rendered outside the table");
  assert.ok(field.includes("document.body"), "into the body, where nothing can crop it");
  assert.ok(
    field.includes('className="fixed z-50 rounded-lg'),
    "positioned against the window rather than an ancestor"
  );
  assert.ok(
    field.includes("trigger.current?.getBoundingClientRect()"),
    "from the trigger's own place on screen"
  );
  /*
   * Which then has to be kept: outside-click closes on anything that is not
   * the trigger, and the panel is no longer inside it. Miss this and picking a
   * date counts as clicking away.
   */
  assert.ok(
    field.includes("if (box.current?.contains(t) || panel.current?.contains(t)) return;"),
    "and a click inside the panel is not a click away from it"
  );
  // The td's overflow-hidden is what made this necessary — if it goes, the
  // comment explaining all of the above stops being true.
  assert.ok(
    read("components/ui/table.tsx").includes("[&_td]:overflow-hidden"),
    "the clipping this works around is still there"
  );

  // Room for two icons where there was one.
  for (const p of ["app/(app)/deliverables/page.tsx", "app/(app)/today/page.tsx"]) {
    assert.ok(read(p).includes('<th className="w-24 text-right">Actions</th>'), `${p} makes room`);
  }
  ok("on a board it is the calendar beside the pencil, not a date clipped to two digits");
}

await finish(pass);
