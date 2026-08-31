/**
 * One client, several groups, and a message that knows which one it wants.
 *
 * Every message the portal sends used to pick "the client's group" the same
 * way in six separate files — default first, then oldest — so all of it
 * landed in one chat. That is fine for a client who has one group and wrong
 * for the ones who don't: the people who sign off the work are rarely the
 * people who pay for it, and an invoice chase in the creative group is a
 * message sent to the wrong room.
 *
 * The fallback is what is really being tested here. Ticking is additive: a
 * group ticked for a job goes first, and where nothing is ticked the ordering
 * falls through to exactly what it picked before. Getting that backwards
 * would mean a client with no boxes ticked silently stops being chased for
 * money, which is the one failure here that costs something.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const wg = await import(pathToFileURL(`${SRC}/lib/whatsapp-groups.ts`).href);
const outbox = await import(pathToFileURL(`${SRC}/lib/reminder-outbox.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM whatsapp_groups WHERE group_id LIKE 'ZZgrp%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ purpose%'");
};

await clean();

/* ------------------------------------------------------------------ *
 * Reading the ticks off a row
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(
    wg.purposesOn({
      for_approvals: 1,
      for_footage: 0,
      for_payments: 0,
      for_updates: 1,
      for_chat: 0,
    }),
    ["approvals", "updates"],
    "a 0 is off and a 1 is on"
  );

  /*
   * A database that has not run the migration has none of these columns, and
   * every screen and every rule must behave exactly as it did before they
   * existed. Missing reads as ticked, everywhere, deliberately.
   */
  assert.deepEqual(
    wg.purposesOn({}),
    ["approvals", "footage", "payments", "updates", "chat"],
    "a column that isn't there yet reads as ticked"
  );
  assert.deepEqual(
    wg.purposesOn({ for_chat: null }),
    ["approvals", "footage", "payments", "updates", "chat"],
    "and so does a NULL"
  );
  ok("ticks are read from the row, and an unmigrated row is ticked");
}

/* ------------------------------------------------------------------ *
 * Which reminder belongs to which group
 * ------------------------------------------------------------------ */
{
  assert.equal(wg.purposeOfReminder("invoice_due"), "payments", "money goes to the money group");
  assert.equal(wg.purposeOfReminder("approval_chase"), "approvals");
  assert.equal(wg.purposeOfReminder("auto_approve"), "approvals");
  /*
   * Footage has a room of its own, asked for after the rest of this was
   * built. It is the only thing here the client has to act on before we can
   * work, and the loudest — three asks a day until the file lands — so it is
   * not lumped in with sign-off.
   */
  assert.equal(wg.purposeOfReminder("footage_due"), "footage", "footage is not an approval");
  assert.equal(wg.purposeOfReminder("monthly_plan"), "updates");
  // An unknown kind is not a crash and not a refusal to send — it goes where
  // ordinary news goes.
  assert.equal(
    wg.purposeOfReminder("something_new"),
    "updates",
    "an unknown kind still has a home"
  );
  ok("every reminder kind names its group once, not once per caller");
}

/* ------------------------------------------------------------------ *
 * Two groups, and the right one for each job
 * ------------------------------------------------------------------ */
const clientId = (
  await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ purpose co', 'active')")
).insertId;

// The default group — everything used to go here, and the fallback still
// does. Inserted first so it is also the oldest.
await db.execute(
  `INSERT INTO whatsapp_groups (client_id, group_id, group_name, is_default, is_active)
   VALUES (?, 'ZZgrp-work@g.us', 'ZZ work', 1, 1)`,
  [clientId]
);
// The accounts group: newer, not the default. Nothing would ever have
// addressed it before this change.
await db.execute(
  `INSERT INTO whatsapp_groups (client_id, group_id, group_name, is_default, is_active)
   VALUES (?, 'ZZgrp-accounts@g.us', 'ZZ accounts', 0, 1)`,
  [clientId]
);

const columnsPresent = await db.hasColumn("whatsapp_groups", "for_payments");

{
  // Nothing configured yet: both groups are ticked for everything, so this
  // must be the old answer — the default group, for every job.
  for (const purpose of ["approvals", "footage", "payments", "updates"]) {
    const t = await outbox.groupForClient(clientId, purpose);
    assert.equal(t?.groupId, "ZZgrp-work@g.us", `${purpose} still goes to the default group`);
  }
  ok("with nothing configured, every message goes exactly where it went before");
}

if (!columnsPresent) {
  console.log("  --  purpose columns not applied here; the routing checks need them");
} else {
  {
    // Money to the accounts group, and only money.
    await wg.setGroupPurposes("ZZgrp-accounts@g.us", ["payments"]);
    await wg.setGroupPurposes("ZZgrp-work@g.us", ["approvals", "footage", "updates", "chat"]);

    assert.equal(
      (await outbox.groupForClient(clientId, "payments"))?.groupId,
      "ZZgrp-accounts@g.us",
      "the invoice goes to the accounts group"
    );
    assert.equal(
      (await outbox.groupForClient(clientId, "approvals"))?.groupId,
      "ZZgrp-work@g.us",
      "the approval does not"
    );
    assert.equal(
      (await outbox.groupForClient(clientId, "updates"))?.groupId,
      "ZZgrp-work@g.us",
      "and neither does the month's plan"
    );
    assert.equal(
      (await outbox.groupForClient(clientId, "footage"))?.groupId,
      "ZZgrp-work@g.us",
      "nor the daily ask for footage"
    );
    ok("each kind of message reaches the group that asked for it");
  }

  {
    /*
     * The case that has to fail safe.
     *
     * Somebody unticks every box on every group — by accident, or because
     * they were tidying. If the ordering filtered rather than ordered, this
     * client would silently stop being chased for money and nobody would
     * find out until the invoice aged. It orders, so the answer is the same
     * one it gave before any of this existed.
     */
    await wg.setGroupPurposes("ZZgrp-accounts@g.us", []);
    await wg.setGroupPurposes("ZZgrp-work@g.us", []);

    const t = await outbox.groupForClient(clientId, "payments");
    assert.equal(t?.groupId, "ZZgrp-work@g.us", "an unticked client is still reachable");
    ok("unticking everything loses a preference, never the client");
  }

  {
    // The assistant is the one place with no fallback: an unticked box is a
    // room it must not speak in, and there is nothing to fall back to.
    await wg.setGroupPurposes("ZZgrp-work@g.us", ["approvals"]);
    assert.equal(await wg.groupAllows("ZZgrp-work@g.us", "chat"), false, "silent where unticked");
    assert.equal(await wg.groupAllows("ZZgrp-work@g.us", "approvals"), true, "and not elsewhere");

    // A group nobody has linked never reaches this — `clientForGroup` turns it
    // away first — but if it ever did, an unknown group is not a refusal.
    assert.equal(
      await wg.groupAllows("ZZgrp-nope@g.us", "chat"),
      true,
      "an unknown group is not a ban"
    );
    ok("the assistant answers only where it was asked to");
  }
}

await clean();

/* ------------------------------------------------------------------ *
 * Wired everywhere a group is chosen
 * ------------------------------------------------------------------ */
{
  /*
   * Six files picked a group by hand, each with the same ORDER BY written
   * out. A seventh copy is how a client ends up chased in three different
   * chats, so none of them may spell the ordering themselves any more.
   */
  for (const f of [
    "lib/whatsapp-reminders.ts",
    "lib/whatsapp-approvals.ts",
    "lib/reminder-outbox.ts",
    "lib/instagram.ts",
  ]) {
    const s = read(f);
    assert.ok(s.includes("groupOrderSql("), `${f} asks for the ordering`);
    assert.ok(
      !/ORDER BY\s+(g\.)?is_default DESC/.test(s),
      `${f} no longer spells the ordering out itself`
    );
  }

  // And the money query in particular, because that is the one that changed
  // which chat it lands in.
  assert.ok(
    read("lib/whatsapp-reminders.ts").includes('ONE_GROUP("payments")'),
    "invoices are chased in the payments group"
  );
  assert.ok(
    read("lib/whatsapp-reminders.ts").includes('ONE_GROUP("footage")'),
    "and footage is asked for in the footage group"
  );
  assert.ok(
    read("app/(app)/payments/actions.ts").includes('groupForClient(inv.client_id, "payments")'),
    "and so is an invoice sent by hand"
  );
  ok("one definition of which group, used by everything that picks one");
}

/* ------------------------------------------------------------------ *
 * The assistant's gate, and the approval clock
 * ------------------------------------------------------------------ */
{
  const route = read("app/api/whatsapp/message/route.ts");
  assert.ok(
    route.includes('if (!(await groupAllows(input.groupId, "chat"))) return false;'),
    "the assistant checks the room before answering"
  );
  // After attribution, not before: an unlinked group is still turned away for
  // the older and stronger reason.
  assert.ok(
    route.indexOf("clientForGroup(input.groupId)") < route.indexOf("groupAllows(input.groupId"),
    "and only for a group that belongs to somebody"
  );

  /*
   * "Approve within 24 hours or we go ahead" is a promise with an hour on it.
   * The reminder run is nightly, so on its own it meant somewhere between 24
   * and 48 — and could deliver the twelve-hour warning in the same run as the
   * decision it was warning about. The publisher runs every quarter hour.
   */
  const pub = read("app/api/automation/publish/run/route.ts");
  assert.ok(pub.includes("runApprovalClock()"), "the publisher keeps the clock");
  const rem = read("lib/whatsapp-reminders.ts");
  assert.ok(rem.includes("export async function runApprovalClock("), "which is one exported rule");
  assert.ok(
    !/runApprovalClock[\s\S]{0,400}recordRun\(/.test(rem),
    "and does not mark the whole nightly job healthy from half of it"
  );
  ok("the 12h warning and the 24h decision happen on the hour, not overnight");
}

await finish(pass);
