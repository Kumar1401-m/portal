/**
 * Two messages a client's group should never receive.
 *
 * ## "Please approve this", about something already approved
 *
 * A super admin can approve in the portal. That writes `status` and
 * `approval_status`; it never touches `wa_status`, because nothing happened on
 * WhatsApp. `prepareSend` was taught this already — but three other things
 * decide what goes into a group, and each of them read a different column:
 *
 *   - `awaitingReplyInGroup`, which is what makes the group's list of "what
 *     are you waiting on us for". Reading `wa_status` alone, it kept an
 *     approved video on that list for ever, so the next thing anybody typed in
 *     the group came back as "more than one video is waiting here" — listing
 *     one that had been approved days earlier.
 *   - the scheduled chase and the auto-approval, both of which treated
 *     `content_review` as "the client owes us an answer". Content review is a
 *     step inside the agency; the client is never sent it and cannot see it.
 *     So the portal chased them about work they had never been shown, and then
 *     told them "we haven't heard back, we're treating it as approved".
 *
 * ## "Send us the raw footage", to a client who never sends any
 *
 * Whether a *task* waits on a shoot was already understood — a poster is drawn
 * and an ad is bought, so neither is chased. What nothing recorded is whether
 * a *client* shoots anything at all. We film some of them ourselves; others
 * buy posters and ads only. Their groups got the footage chase every month
 * regardless, and the answer was always the same, which is how a client learns
 * to stop reading the group.
 *
 * Turning it off is a decision about what we send them and nothing else: a
 * link they send anyway is still accepted, and the agency's own boards still
 * show what is outstanding.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const load = (p) => import(pathToFileURL(`${SRC}/${p}`).href);

const db = await load("lib/db.ts");
const wa = await load("lib/whatsapp-approvals.ts");
const msg = await load("lib/reminder-messages.ts");
const scope = await load("lib/footage-scope.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

const GROUP = "ZZ-second-ask@g.us";

/* ------------------------------------------------------------------ *
 * An approved video leaves the group's waiting list
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ second ask%'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ second ask'");
  };
  await clean();
  const cid = Number(
    (await db.execute(
      "INSERT INTO clients (company_name, status) VALUES ('ZZ second ask','active')"
    )).insertId
  );

  const mk = async (title, status, approval, waStatus) =>
    Number((await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, approval_status, wa_status, wa_group_id, video_code)
       VALUES (?,?,?,?,?,?,?)`,
      [cid, title, status, approval, waStatus, GROUP, `ZZ${Math.floor(Math.random() * 1e6)}`]
    )).insertId);

  try {
    // Sent, and genuinely unanswered. This one must stay.
    await mk("ZZ second ask waiting", "review", "pending", "sent");
    // Approved at a desk. wa_status still says 'sent', because it always will.
    await mk("ZZ second ask desk", "approved", "approved", "sent");
    // Answered with changes: the ball is ours, not theirs.
    await mk("ZZ second ask changes", "changes_requested", "changes_requested", "viewed");
    // Already published. Asking permission for this is the worst of the three.
    await mk("ZZ second ask posted", "posted", "approved", "delivered");

    const waiting = await wa.awaitingReplyInGroup(GROUP);
    const titles = waiting.map((r) => r.title);
    assert.deepEqual(titles, ["ZZ second ask waiting"], "only the unanswered one is waiting");
    ok("a video answered in the portal drops off the group's waiting list");

    /*
     * Which is what stops the group being asked to choose. With four videos
     * on the list this resolved as ambiguous and sent the client a menu; with
     * one, a bare "ok" is simply understood.
     */
    const resolved = await wa.resolveVideoForGroup(GROUP);
    assert.equal(resolved.ok, true, "so a plain 'ok' resolves instead of asking back");
    ok("and the group is never asked to pick between videos it has already answered");

    /*
     * Revert-proof: the fix is the `settledSql` clause, not the fixture. Run
     * the same query without it and all four come back — which is exactly the
     * list the client used to be shown.
     */
    const unguarded = await db.query(
      `SELECT title FROM deliverables
        WHERE wa_group_id = ? AND wa_status IN ('queued','sending','sent','delivered','viewed')`,
      [GROUP]
    );
    assert.equal(unguarded.length, 4, "and without the guard all four would still be listed");
    ok("the guard is what does it, not the fixture");

    /*
     * The manual chase from Settings → Reminders reads the same rule, and it
     * is the sharpest test of it: this builds the actual words sent to the
     * group. The one genuinely unanswered video is named, and the three that
     * were answered elsewhere are not — the whole complaint being a client
     * asked a second time about work already signed off.
     */
    const chase = await msg.composeReminder("approval_chase", cid);
    assert.ok(chase.text, "the one still with the client is chased");
    assert.match(chase.text, /ZZ second ask waiting/, "and named");
    for (const gone of ["desk", "changes", "posted"]) {
      assert.ok(
        !chase.text.includes(`ZZ second ask ${gone}`),
        `an already-answered video (${gone}) is never chased again`
      );
    }
    ok("the by-hand chase agrees with the automatic one");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Content review is ours, so the client is never chased about it
 * ------------------------------------------------------------------ */
{
  const reminders = read("lib/whatsapp-reminders.ts");
  assert.equal(
    reminders.split("d.status = 'review' AND NOT ${settledSql(\"d.\")}").length - 1,
    2,
    "the chase and the auto-approval both ask the narrow question"
  );
  /*
   * One place still counts both, and must: the team's own digest goes to the
   * agency group, where content review is exactly the thing worth knowing
   * about. The distinction is who is reading, not which status it is.
   */
  assert.equal(
    reminders.split("d.status IN ('content_review','review')").length - 1,
    1,
    "and the only reader left counting both is the agency's own digest"
  );
  assert.ok(
    reminders
      .slice(reminders.indexOf("async function teamDigest"))
      .includes("d.status IN ('content_review','review')"),
    "which is where it survives"
  );

  const ai = read("lib/whatsapp-ai.ts");
  assert.ok(
    !ai.includes('s === "content_review"'),
    "and the group assistant does not volunteer it in conversation either"
  );

  const summary = read("app/api/whatsapp/summary/route.ts");
  assert.ok(
    !summary.includes("status IN ('content_review','review')"),
    "nor the summary the group is sent"
  );
  ok("an internal step is never described to a client as something they owe us");

  /*
   * The reason it is internal, kept honest. If content review ever goes back
   * to being sent to clients, this line goes with it — and the four checks
   * above become wrong rather than merely stale.
   */
  const actions = read("app/(app)/deliverables/actions.ts");
  assert.ok(
    actions.includes("Content review is a step inside the agency now."),
    "and the transition that makes that true still says so"
  );
  ok("the premise is still in force");
}

/* ------------------------------------------------------------------ *
 * A client who sends no footage is never asked for any
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ footage flag%'");
    await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ footage flag%'");
  };
  await clean();

  const mkClient = async (name, provides) =>
    Number((await db.execute(
      "INSERT INTO clients (company_name, status, provides_footage) VALUES (?,'active',?)",
      [name, provides]
    )).insertId);

  try {
    const filmed = await mkClient("ZZ footage flag shoots", 1);
    const notFilmed = await mkClient("ZZ footage flag never", 0);

    for (const [cid, title] of [
      [filmed, "ZZ footage flag one"],
      [notFilmed, "ZZ footage flag two"],
    ]) {
      await db.execute(
        `INSERT INTO deliverables (client_id, title, status, service, due_date)
         VALUES (?,?, 'waiting_for_raw', 'video_editing', CURDATE())`,
        [cid, title]
      );
    }

    const asked = await msg.composeReminder("footage_due", filmed);
    assert.ok(asked.text, "a client who films with us is still asked");
    assert.match(asked.text, /ZZ footage flag one/, "and told which piece");

    const spared = await msg.composeReminder("footage_due", notFilmed);
    assert.equal(spared.text, null, "a client who sends nothing is not asked");
    assert.match(spared.nothing, /Nothing is waiting on footage/, "and nothing goes out");
    ok("the footage chase asks only the clients who actually send footage");

    /*
     * Revert-proof, and the distinction that matters: the *task* rule alone
     * cannot tell these two apart. Both are video editing, both are waiting.
     * Only the client flag separates them, so if it stops being read, this
     * count goes back to two.
     */
    const bare = await db.query(
      `SELECT title FROM deliverables
        WHERE client_id IN (?,?) AND status = 'waiting_for_raw'
          AND ${(await import(pathToFileURL(`${SRC}/lib/raw-footage.ts`).href)).needsRawFootageSql("")}`,
      [filmed, notFilmed]
    );
    assert.equal(bare.length, 2, "the task rule on its own still sees both");

    const scoped = await db.query(
      `SELECT title FROM deliverables
        WHERE client_id IN (?,?) AND status = 'waiting_for_raw'
          AND ${await scope.footageChaseSql("")}`,
      [filmed, notFilmed]
    );
    assert.equal(scoped.length, 1, "and the client flag is what removes the second");
    ok("the flag does the work, and the task rule is unchanged beneath it");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Not asking is not the same as not needing
 * ------------------------------------------------------------------ */
{
  /*
   * The switch governs what leaves the building. Three readers deliberately
   * ignore it, and each would be a bug if it did not:
   *
   *   - the route that ACCEPTS a link, or a client who sent one anyway would
   *     be told we did not want it
   *   - the agency's own boards and the assistant, which have to show the
   *     work that is actually outstanding
   *   - the client's portal, which is theirs to read
   */
  for (const [file, why] of [
    ["app/api/whatsapp/footage/route.ts", "a link sent anyway is still taken"],
    ["lib/assistant.ts", "the agency still sees what is outstanding"],
    ["lib/automation-map.ts", "and so do its counts"],
    ["lib/portal.ts", "and the client's own portal is unchanged"],
  ]) {
    const src = read(file);
    assert.ok(src.includes("needsRawFootageSql"), `${file}: ${why}`);
    assert.ok(!src.includes("footageChaseSql"), `${file}: and it is not narrowed by the switch`);
  }
  ok("turning the chase off silences the messages, and nothing else");
}

await finish(pass);
