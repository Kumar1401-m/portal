/**
 * Who decides where a written brief goes.
 *
 * Whether a piece goes to the client for sign-off or straight to the team is a
 * decision about that client, and it belongs to the super admin — not to
 * whoever typed the copy. So the writer's last step hands it over, and both
 * buttons live on the Approvals board.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- the writer submits, and does not send ---------------- */
{
  const brief = readFileSync(`${SRC}/app/(app)/content/brief-row.tsx`, "utf8");
  const actions = readFileSync(`${SRC}/app/(app)/content/actions.ts`, "utf8");

  has(brief, "submitForApprovalAction", "the popup submits for approval");
  assert.ok(
    !/sendContentAction|handToTeamAction/.test(brief),
    "and cannot send to the client or release to the team from there"
  );
  has(actions, "export async function submitForApprovalAction", "which is a real step");
  has(actions, 'if (!(row[0].description ?? "").trim())', "with nothing empty submitted");
  // Telling somebody their own action happened is how a list becomes noise —
  // and it is already on their own board either way.
  has(actions, 'if (user.role !== "super_admin") {', "and no alert to whoever did it");

  // The only bar on the button is having written something. It used to also
  // want a role and a linked group, which are no longer this step's business.
  has(brief, "const canSendThis = body.trim().length > 0;", "written is the only condition");
  ok("the writer hands the brief over rather than sending it out");
}

/* ---------------- the queue needs no new status ---------------- */
{
  // "Written but not sent" is already expressible. A new ENUM value means a
  // migration and a feature switched off until somebody remembers to run it.
  const lib = readFileSync(`${SRC}/lib/deliverables.ts`, "utf8");
  has(
    lib,
    "d.status = 'pending' AND TRIM(COALESCE(d.description,'')) <> ''",
    "the queue is written-but-not-sent"
  );
  has(lib, "AS written", "and the tab count is the same rule, so the two agree");

  const schema = readFileSync(`${SRC}/../../database/schema.sql`, "utf8");
  assert.ok(
    !/content_ready|content_written/.test(schema),
    "no status was invented for it"
  );
  ok("the super admin's queue is a query, not a migration");
}

/* ---------------- and the decision is on the Approvals board ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/approvals/page.tsx`, "utf8");
  has(page, 'label: "Content ready"', "it has a tab of its own");
  has(page, "contentWritten: true", "selecting the written ones");
  has(page, "active.contentWritten && canSend", "carrying both decisions");
  has(page, "sendContentToClient", "to the client for sign-off");
  has(page, "approveContentToTeam", "or past them, to whoever makes it");
  // First, because it is the step before everything else on that board.
  assert.ok(
    page.indexOf('key: "written"') < page.indexOf('key: "content"'),
    "and it comes before the gates that follow it"
  );

  const acts = readFileSync(`${SRC}/app/(app)/content/approval-actions.ts`, "utf8");
  has(
    acts,
    'if (user.role !== "super_admin" && user.role !== "crm") return null;',
    "both reserved to the super admin and the client's own crm"
  );
  has(acts, "TRIM(COALESCE(d.description,'')) <> ''", "and neither acts on an empty brief");
  // Releasing to the team is the same hand-off as everywhere else: the person
  // it lands on is told.
  has(acts, "notifyUser(", "releasing to the team tells the maker");
  ok("the super admin chooses, on the board they were told to look at");
}

await finish(pass);
