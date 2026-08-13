/**
 * What the three status columns say, and what colour they say it in.
 *
 * These are scanned, not read — a column of badges is judged on colour first
 * and words second. So the rules worth pinning are: one meaning per colour,
 * the two outcomes that matter most never share one, and no status is
 * invisible.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const c = await load("lib/constants.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const ALL = [
  "pending", "content_review", "waiting_for_raw", "raw_uploaded", "editing",
  "caption_ready", "review", "changes_requested", "resolved", "approved",
  "scheduled", "posted", "completed", "rejected", "cancelled",
];

/* ---------------- design status ends at approved ---------------- */
{
  // It sits next to a Post status column. Repeating "Posted" in both wasted
  // the width and hid where the design work actually got to.
  for (const s of ["approved", "scheduled", "posted", "completed"]) {
    assert.equal(c.editorStatusLabel(s), "Approved", `${s} reads as Approved in the design column`);
  }
  assert.equal(c.postStatusLabel("posted"), "Posted", "and the post column keeps that word");
  assert.equal(c.postStatusLabel("scheduled"), "Scheduled");
  ok("the design column ends at Approved; where it went is the next column's job");
}

/* ---------------- the three that were wrong ---------------- */
{
  // Somebody asked for the work again and the column said it was done.
  assert.equal(c.editorStatusLabel("changes_requested"), "Changes requested");
  assert.notEqual(c.editorStatusLabel("changes_requested"), "Edited");

  // Two outcomes worth noticing looked like missing data.
  assert.equal(c.editorStatusLabel("rejected"), "Rejected");
  assert.equal(c.editorStatusLabel("cancelled"), "Cancelled");
  for (const s of ALL) {
    assert.notEqual(c.editorStatusLabel(s), "—", `${s} is never a dash`);
    assert.ok(c.editorStatusLabel(s).length > 2, `${s} has a real label`);
  }
  ok("a change request says so, and nothing renders as an em dash");
}

/* ---------------- one meaning per colour ---------------- */
{
  const tone = c.editorStatusTone;

  // The pair it matters most to tell apart, and they used to be the same.
  assert.notEqual(
    tone("approved"),
    tone("changes_requested"),
    "approved and changes requested must not share a colour"
  );
  assert.equal(tone("approved"), "success");
  assert.equal(tone("changes_requested"), "danger");
  assert.equal(tone("rejected"), "danger");

  // Being worked on, versus sitting with a person: different answers to
  // "is anyone doing anything about this".
  assert.equal(tone("editing"), "active");
  assert.equal(tone("raw_uploaded"), "active");
  assert.equal(tone("caption_ready"), "waiting");
  assert.equal(tone("review"), "waiting");
  assert.notEqual(tone("editing"), tone("review"));

  assert.equal(tone("pending"), "muted");
  assert.equal(tone("cancelled"), "muted");
  ok("green is signed off, red needs doing again, blue is in hand, violet is waiting");

  // Every tone used must exist in the Badge, or it renders unstyled.
  const badge = readFileSync(`${SRC}/components/ui/badge.tsx`, "utf8");
  const declared = new Set(
    (badge.match(/^\s{2}(\w+):\s*$|^\s{2}(\w+):\s*"/gm) || []).map((m) =>
      m.trim().replace(/:.*$/, "")
    )
  );
  for (const s of ALL) {
    for (const fn of [c.editorStatusTone, c.contentStatusTone]) {
      assert.ok(declared.has(fn(s)), `${fn(s)} is a real Badge tone`);
    }
  }
  assert.ok(declared.has("waiting") && declared.has("active"), "the two new tones exist");
  ok("every tone the boards ask for is one the Badge can actually paint");
}

/* ---------------- an invoice answers "paid?" ---------------- */
{
  assert.equal(c.invoiceStatusLabel("paid"), "Paid");
  // The whole complaint: "Sent" says we posted it, not that money arrived.
  assert.equal(c.invoiceStatusLabel("sent"), "Unpaid");
  assert.equal(c.invoiceStatusLabel("overdue"), "Unpaid · overdue");
  assert.equal(c.invoiceStatusLabel("partial"), "Part paid");
  assert.equal(c.invoiceStatusLabel("draft"), "Draft");
  assert.equal(c.invoiceStatusLabel("cancelled"), "Cancelled");
  // The enum could grow; an unknown status is unpaid, which is the safe read.
  assert.equal(c.invoiceStatusLabel("something_new"), "Unpaid");
  ok("every invoice state answers whether the money arrived");

  assert.equal(c.invoiceStatusTone("paid"), "success");
  assert.equal(c.invoiceStatusTone("overdue"), "danger", "overdue is chased today");
  assert.equal(c.invoiceStatusTone("partial"), "warning");
  assert.equal(c.invoiceStatusTone("sent"), "waiting");
  // Nothing is owed on a draft — it has not been sent.
  assert.equal(c.invoiceStatusTone("draft"), "muted");
  assert.notEqual(c.invoiceStatusTone("paid"), c.invoiceStatusTone("sent"));
  ok("only paid is green, and overdue is the one that shouts");

  for (const p of ["app/(app)/payments/page.tsx", "app/portal/invoices/page.tsx"]) {
    const src = readFileSync(`${SRC}/${p}`, "utf8");
    assert.match(src, /invoiceStatusLabel\(inv\.status\)/, `${p} uses it`);
    assert.match(src, /invoiceStatusTone\(inv\.status\)/, `${p} colours by it`);
  }
  ok("both the agency's invoice list and the client's own use them");
}

/* ---------------- label and colour come from the same fold ---------------- */
{
  /*
   * The boards coloured with the generic `statusTone` while labelling with
   * `contentStatusLabel`, and the two fold the statuses differently. Four rows
   * all reading "Content approved" came out in three colours — grey, grey,
   * amber — which reads as three different things.
   */
  const pairedWith = (v) =>
    new RegExp(`contentStageTone\\(${v}\\.status\\)\\}>\\{contentStageLabel\\(${v}\\.status\\)`);
  const designPairedWith = (v) =>
    new RegExp(`editorStatusTone\\(${v}\\.status\\)\\}>\\{editorStatusLabel\\(${v}\\.status\\)`);

  for (const p of ["app/(app)/deliverables/page.tsx", "app/(app)/today/page.tsx"]) {
    const src = readFileSync(`${SRC}/${p}`, "utf8");
    assert.match(src, pairedWith("d"), `${p} colours the content column with the fold that labels it`);
    assert.match(src, designPairedWith("d"), `${p} does the same for the design column`);
  }
  const mw = readFileSync(`${SRC}/app/(app)/my-work/page.tsx`, "utf8");
  assert.match(mw, designPairedWith("t"));

  // The four that share a label must share a colour.
  const approved = ["waiting_for_raw", "raw_uploaded", "editing", "caption_ready"];
  for (const s of approved) assert.equal(c.contentStatusLabel(s), "Content approved");
  const tones = new Set(approved.map((s) => c.contentStatusTone(s)));
  assert.equal(tones.size, 1, `one label, one colour — got ${[...tones].join(", ")}`);
  // The staff fold only renames the two that need a person, and inherits the
  // rest — so it cannot drift away from the fold above it.
  for (const s of [...approved, "review", "approved", "rejected"]) {
    assert.equal(c.contentStageLabel(s), c.contentStatusLabel(s), `${s} is unchanged for staff`);
    assert.equal(c.contentStageTone(s), c.contentStatusTone(s));
  }
  ok("rows that say the same thing look the same");
}

/* ---------------- and the two that need a person say who ---------------- */
{
  // "Yet to start" is a fair answer on the client's own board and a useless
  // one on ours: it does not say whether we owe them a brief or they owe us
  // an answer. The client-facing wording is deliberately left alone.
  assert.equal(c.contentStatusLabel("pending"), "Yet to start", "the client's board is untouched");
  assert.equal(c.contentStageLabel("pending"), "Content to write");
  assert.equal(c.contentStageLabel("content_review"), "Content with client");

  // A brief nobody has written is our own move, so it is not the grey that
  // let it be missed.
  assert.equal(c.contentStatusTone("pending"), "muted");
  assert.notEqual(c.contentStageTone("pending"), "muted", "ours to do does not look like nothing");

  // The client portal keeps the client's words.
  for (const p of ["app/portal/content/page.tsx"]) {
    const src = readFileSync(`${SRC}/${p}`, "utf8");
    assert.ok(!/contentStage/.test(src), `${p} does not show a client our internal wording`);
  }
  ok("the staff boards name whose move it is, and the client's board does not");
}

await finish(pass);
