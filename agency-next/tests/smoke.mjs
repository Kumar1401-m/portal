/** Real modules, real schema, real queries. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const messages = await load("lib/reminder-messages.ts");
const outbox = await load("lib/reminder-outbox.ts");
const db = await load("lib/db.ts");
const zapier = await load("lib/posting.ts");

let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`  ok  ${name}`);
};

/* ---------------- the words ---------------- */

{
  const t = messages.footageText([{ title: "Reel 1", due_date: "2026-08-12" }]);
  assert.match(t, /due to start editing on \*12 Aug 2026\*/);
  assert.match(t, /This one:/);
  assert.match(t, /• Reel 1/);
  assert.ok(!t.includes("— 12 Aug"), "single shared date must not repeat per line");
  ok("footage, one item, one date — leads with the date");
}
{
  const t = messages.footageText([
    { title: "Reel 1", due_date: "2026-08-12" },
    { title: "Reel 2", due_date: "2026-08-20" },
  ]);
  assert.ok(!t.includes("due to start editing on"), "mixed dates must not claim one deadline");
  assert.match(t, /• Reel 1 — 12 Aug 2026/);
  assert.match(t, /• Reel 2 — 20 Aug 2026/);
  assert.match(t, /these 2:/, "the count and plural are right");
  ok("footage, mixed dates — no false single deadline, each line dated");
}
{
  const many = Array.from({ length: 11 }, (_, i) => ({ title: `Reel ${i + 1}`, due_date: null }));
  const t = messages.footageText(many);
  assert.match(t, /…and 3 more\./);
  assert.ok(!t.includes("Reel 9"), "only the first 8 are listed");
  ok("footage, 11 items — lists 8 and counts the rest");
}
{
  const one = messages.approvalChaseText([{ title: "Diwali reel", video_code: "V101" }]);
  assert.match(one, /\*Diwali reel\* is still waiting/);
  // The command token is what must not drift; the sentence around it is tone.
  assert.match(one, /please reply \*OK\* to approve/i);
  assert.ok(!one.includes("V101"), "one waiting video needs no code — a bare OK is unambiguous");
  ok("approval chase, one video — plain OK, no code");
}
{
  const many = messages.approvalChaseText([
    { title: "A", video_code: "V101" },
    { title: "B", video_code: "V102" },
  ]);
  assert.match(many, /2 are still waiting/);
  assert.match(many, /\*V101\* — A/);
  assert.match(many, /please reply \*OK V101\*/i);
  ok("approval chase, several — names the codes, since a bare OK is refused");
}
{
  const payable = messages.invoiceText([
    { invoice_no: "INV-9", total: 25000, due_date: "2026-08-01", payUrl: "https://rzp.io/i/x", payable: true },
  ]);
  assert.match(payable, /https:\/\/rzp\.io\/i\/x/);
  assert.match(payable, /opens straight into UPI/);
  assert.match(payable, /₹25,000/);

  const fallback = messages.invoiceText([
    { invoice_no: "INV-9", total: 25000, due_date: null, payUrl: "https://p/portal/invoices", payable: false },
  ]);
  assert.match(fallback, /view and pay it in your portal/);
  assert.ok(!fallback.includes("which was due"), "no due date, no due-date clause");
  ok("payment reminder — real link and portal fallback read differently");
}

/* ---------------- what the DB says ---------------- */

const TAG = "ZZ smoke client";
await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-SMOKE-%'");
await db.execute("DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name = ?)", [TAG]);
await db.execute("DELETE FROM clients WHERE company_name = ?", [TAG]);

const made = await db.execute(
  "INSERT INTO clients (company_name, status, email, phone) VALUES (?, 'active', 'x@example.com', '9999999999')",
  [TAG]
);
const client = { id: Number(made.insertId), company_name: TAG };
const month = new Date().toISOString().slice(0, 7);

// A client with nothing outstanding must be reported as such, not sent a blank.
for (const kind of ["footage_due", "approval_chase", "monthly_plan", "invoice_due"]) {
  const res = await messages.composeReminder(kind, client.id);
  assert.equal(res.text, null, `${kind} has nothing to say for an empty client`);
  assert.ok(res.nothing, `${kind} says why there is nothing to send`);
}
ok("a client with nothing outstanding gets a reason, never a blank message");

await db.execute(
  `INSERT INTO deliverables (client_id, title, status, due_date, month_key, video_code)
   VALUES (?, 'Smoke reel — footage', 'waiting_for_raw', DATE_ADD(CURDATE(), INTERVAL 3 DAY), ?, NULL),
          (?, 'Smoke reel — approval', 'review', CURDATE(), ?, 'VZZ1'),
          (?, 'Smoke reel — approval 2', 'review', CURDATE(), ?, 'VZZ2')`,
  [client.id, month, client.id, month, client.id, month]
);
await db.execute(
  `INSERT INTO invoices (invoice_no, client_id, total, status, due_date)
   VALUES ('ZZ-SMOKE-1', ?, 12500.00, 'sent', DATE_SUB(CURDATE(), INTERVAL 4 DAY))`,
  [client.id]
);

const composed = {};
for (const kind of ["footage_due", "approval_chase", "monthly_plan", "invoice_due"]) {
  const res = await messages.composeReminder(kind, client.id);
  assert.ok(res.text, `${kind} must produce words, got ${JSON.stringify(res)}`);
  assert.ok(res.text.length < 4000, `${kind} fits in one WhatsApp message`);
  composed[kind] = res.text;
}
assert.match(composed.footage_due, /Smoke reel — footage/);
assert.ok(!composed.footage_due.includes("approval"), "the footage chase lists only what is missing footage");
assert.match(composed.approval_chase, /VZZ1/, "two waiting videos means the codes are named");
/*
 * Both fixtures sit at "review", which is the gate the client is actually
 * shown. One of them used to sit at "content_review" — and was chased, which
 * was the bug: content review happens inside the agency, so the client was
 * being asked to approve something they had never seen. no-second-ask.mjs
 * holds that line; this one needs two videos at the same gate to exercise the
 * many-videos wording, where the codes appear.
 */
assert.match(composed.monthly_plan, /3 pieces of content/);
assert.match(composed.invoice_due, /ZZ-SMOKE-1/);
assert.match(composed.invoice_due, /₹12,500/);
// No Razorpay keys locally, so it must fall back rather than fail.
assert.match(composed.invoice_due, /\/portal\/invoices/);
ok("every composer builds the right message from the real schema");

{
  const res = await messages.composeReminder("team_digest", null);
  assert.ok(res.text || res.nothing);
  ok("team digest composes without a client");
}

/* ---------------- the queue ---------------- */

assert.equal(await outbox.outboxReady(), true, "whatsapp_outbox must exist after migrate");

const GROUP = "test-group@g.us";
await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);

// Not yet due: an hour out.
const future = new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace("T", " ");
const futureId = await outbox.queueMessage({
  kind: "custom", clientId: client.id, groupId: GROUP, groupLabel: "Test",
  body: "later", sendAt: future, createdByName: "test",
});
assert.ok(futureId > 0);

// Due: an hour ago.
const past = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace("T", " ");
const dueId = await outbox.queueMessage({
  kind: "custom", clientId: client.id, groupId: GROUP, groupLabel: "Test",
  body: "now", sendAt: past, createdByName: "test",
});

const listed = await outbox.listScheduled();
assert.ok(listed.some((r) => r.id === futureId), "a scheduled message shows on the list");
ok("queueing puts a message on the schedule");

/*
 * The WhatsApp service is not configured here, so sendTextToGroup answers
 * { ok: false } — which is precisely the case the old code mistook for
 * success. The row must survive as retryable, not be marked sent.
 */
const run = await outbox.sendDueMessages();
assert.equal(run.ran, true);
assert.equal(run.sent, 0, "nothing can actually be sent with no service configured");

const [afterDue] = await db.query("SELECT * FROM whatsapp_outbox WHERE id = ?", [dueId]);
assert.equal(afterDue.status, "scheduled", "a failed send goes back on the queue, not to 'sent'");
assert.equal(Number(afterDue.attempts), 1, "the attempt is counted");
assert.ok(afterDue.last_error, "and the reason is recorded");

const [afterFuture] = await db.query("SELECT * FROM whatsapp_outbox WHERE id = ?", [futureId]);
assert.equal(Number(afterFuture.attempts), 0, "a message not yet due is left alone");
ok("a send that fails is retried, not silently marked sent");

// Four attempts is the ceiling; the first is already spent.
for (let i = 0; i < 3; i++) await outbox.sendDueMessages();
const [exhausted] = await db.query("SELECT * FROM whatsapp_outbox WHERE id = ?", [dueId]);
assert.equal(exhausted.status, "failed", "gives up rather than retrying for ever");
assert.equal(Number(exhausted.attempts), 4);
ok("gives up after 4 attempts");

// A runner killed between claiming and sending must not strand the message.
{
  await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);
  const stuckId = await outbox.queueMessage({
    kind: "custom", clientId: null, groupId: GROUP, body: "stranded", sendAt: past,
  });
  // Exactly what a killed function leaves behind: claimed, never resolved.
  const longAgo = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  await db.execute(
    "UPDATE whatsapp_outbox SET status='sending', attempts=1, claimed_at=? WHERE id=?",
    [longAgo, stuckId]
  );
  const before = await outbox.listScheduled();
  assert.ok(before.some((r) => r.id === stuckId && r.status === "sending"));

  const rescue = await outbox.sendDueMessages();
  assert.equal(rescue.recovered, 1, "the stranded message is taken back");
  const [after] = await db.query("SELECT * FROM whatsapp_outbox WHERE id = ?", [stuckId]);
  assert.equal(Number(after.attempts), 2, "and retried — the lost attempt still counts");
  assert.notEqual(after.status, "sending", "it does not go straight back to being stuck");

  // A claim made just now is somebody's live send and must be left alone.
  await db.execute(
    "UPDATE whatsapp_outbox SET status='sending', claimed_at=? WHERE id=?",
    [new Date().toISOString().slice(0, 19).replace("T", " "), stuckId]
  );
  const noRescue = await outbox.sendDueMessages();
  assert.ok(!noRescue.recovered, "a fresh claim is not stolen from a send in progress");
  await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);
  ok("a runner killed mid-send releases its message; a live send keeps it");
}

// Cancelling.
await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);
const futureId2 = await outbox.queueMessage({
  kind: "custom", clientId: null, groupId: GROUP, body: "later", sendAt: future,
});
const dueId2 = await outbox.queueMessage({
  kind: "custom", clientId: null, groupId: GROUP, body: "gone", sendAt: past,
});
for (let i = 0; i < 4; i++) await outbox.sendDueMessages();
assert.equal(await outbox.cancelMessage(futureId2), true);
assert.equal(await outbox.cancelMessage(futureId2), false, "cancelling twice is not a second cancel");
assert.equal(await outbox.cancelMessage(dueId2), false, "a failed message cannot be 'cancelled'");
ok("cancel only takes a message that is still waiting");

/* ---------------- the clock ---------------- */

{
  // 6pm IST is 12:30 UTC. The whole promise of "set chesina time" rests on this.
  const utc = zapier.localTimeToUtc("2026-08-20T18:00", "india");
  assert.equal(utc, "2026-08-20 12:30:00");
  assert.equal(zapier.utcToLocalInput(utc, "india"), "2026-08-20T18:00");
  ok("6pm Indian time stores as 12:30 UTC and reads back as 6pm");
}
{
  // Due-ness must not depend on the database's own timezone.
  const [row] = await db.query("SELECT NOW() AS db_now");
  const dbNow = Date.parse(String(row.db_now).replace(" ", "T") + "Z");
  const skewHours = Math.abs(dbNow - Date.now()) / 3600_000;
  console.log(`  note  database clock differs from UTC by ~${skewHours.toFixed(1)}h`);
  // sendDueMessages compares send_at against the app's UTC, never NOW(), so a
  // skewed database clock cannot make a message early or late.
  await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);
  const soon = new Date(Date.now() + 120_000).toISOString().slice(0, 19).replace("T", " ");
  const id = await outbox.queueMessage({
    kind: "custom", clientId: null, groupId: GROUP, body: "x", sendAt: soon,
  });
  await outbox.sendDueMessages();
  const [r] = await db.query("SELECT attempts FROM whatsapp_outbox WHERE id = ?", [id]);
  assert.equal(Number(r.attempts), 0, "two minutes away must not be treated as due");
  ok("due-ness uses the app's clock, not the database's");
}

await db.execute("DELETE FROM whatsapp_outbox WHERE group_id = ?", [GROUP]);
await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-SMOKE-%'");
await db.execute("DELETE FROM deliverables WHERE client_id = ?", [client.id]);
await db.execute("DELETE FROM clients WHERE id = ?", [client.id]);
console.log(`\n${pass} checks passed.`);
process.exit(0);
