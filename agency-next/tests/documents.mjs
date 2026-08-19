/**
 * The two things a client is *sent*: the month, and the bill.
 *
 * Both are opened from a link in a WhatsApp group by somebody who is not
 * signed in, so the token in that link is the whole of the access control —
 * and both are about money or about work that was paid for, so the failure
 * that matters is not a crash. It is a document that contradicts itself, or
 * one that opens for the wrong person.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const links = await load("lib/doc-link.ts");
const payments = await load("lib/payments.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute(
    "DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'ZZ-DOC%')"
  );
  await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-DOC%'");
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ doc client'");
};
await clean();

/* ---------------- the link is the permission ---------------- */
{
  const a = links.docToken("report", 7, "2026-08");

  // Same inputs, same token — the link in last month's message must keep
  // working, so nothing here may depend on the time it was minted.
  assert.equal(a, links.docToken("report", 7, "2026-08"), "the token is stable");
  assert.ok(links.verifyDocToken("report", 7, "2026-08", a));

  // Every part of what the document IS is signed. A link to August that could
  // be edited into September, or one client's report into another's, would be
  // a link that hands out documents it was never issued for.
  assert.ok(!links.verifyDocToken("report", 7, "2026-09", a), "the month is signed");
  assert.ok(!links.verifyDocToken("report", 8, "2026-08", a), "the client is signed");
  assert.ok(!links.verifyDocToken("invoice", 7, "2026-08", a), "an invoice token is not a report token");
  assert.ok(!links.verifyDocToken("report", 7, "2026-08", ""), "nothing is not a token");
  assert.ok(!links.verifyDocToken("report", 7, "2026-08", `${a}x`), "nor is a longer one");
  assert.ok(!links.verifyDocToken("report", 7, "2026-08", a.slice(0, -1) + "x"), "nor a near miss");

  // Absolute, because it is pasted into a WhatsApp message.
  assert.match(links.reportLink(7, "2026-08"), /^https?:\/\/.+\/report\/7\?month=2026-08&k=.{32}$/);
  assert.match(links.invoiceLink(12, "INV-2026-0007"), /^https?:\/\/.+\/invoice\/12\?k=.{32}$/);

  // An invoice link dies if the invoice is reissued under a new number.
  const inv = links.docToken("invoice", 12, "INV-2026-0007");
  assert.ok(!links.verifyDocToken("invoice", 12, "INV-2026-0008", inv), "the number is signed too");
  ok("a document link carries its own permission, and only for that document");
}

/* ---------------- both pages check it before they render ---------------- */
{
  for (const [page, kind] of [
    ["app/report/[id]/page.tsx", "report"],
    ["app/invoice/[id]/page.tsx", "invoice"],
  ]) {
    const src = read(page);
    assert.match(src, /verifyDocToken\("/, `${kind}: the token is checked`);
    // No token is not "no document" — staff open these from the portal, and
    // are checked against the client the ordinary way.
    assert.match(src, /requireUser\(ADMIN_OR_CRM_ROLES\)/, `${kind}: staff fall back to a session`);
    assert.match(src, /canAccessClient\(/, `${kind}: and only their own clients`);
    assert.match(src, /notFound\(\)/, `${kind}: anything else is not there`);

    // Without these the "PDF" is a screenshot of a web page: no page size, the
    // colour dropped by the browser, and the controls printed on the document.
    assert.match(src, /<Paper/, `${kind}: same stationery`);
  }

  const paper = read("components/document.tsx");
  assert.match(paper, /@page \{ size: A4/, "laid out for paper");
  assert.match(paper, /print-color-adjust: exact/, "the colour survives printing");
  assert.match(paper, /print:hidden/, "the controls do not print");
  assert.match(read("components/print-button.tsx"), /window\.print\(\)/, "the browser writes the PDF");

  // The report's month is validated before the token is checked against it —
  // the other order would let a junk month fall back to this one and hand out
  // a document the link was never signed for.
  const report = read("app/report/[id]/page.tsx");
  const monthAt = report.indexOf("const month =");
  const verifyAt = report.indexOf("verifyDocToken(");
  assert.ok(monthAt > 0 && verifyAt > monthAt, "the month is settled before the token is checked");
  ok("both documents check the link, fall back to a session, and are laid out for paper");
}

/* ---------------- the chart is a chart, not a decoration ---------------- */
{
  const chart = await load("lib/chart-slices.ts");

  // Five fixed hues, in order, and a neutral for the tail. A generated sixth
  // hue is indistinguishable from one of the five under colour blindness —
  // these five were run through a palette validator against white.
  assert.equal(chart.SERIES.length, 5, "five categorical hues");
  assert.equal(new Set(chart.SERIES).size, 5, "all different");
  assert.ok(chart.SERIES.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.ok(!chart.SERIES.includes(chart.REST), "the neutral is not one of them");

  const slices = chart.toSlices(
    new Map([["a", 10], ["b", 8], ["c", 6], ["d", 4], ["e", 2], ["f", 1], ["g", 1]])
  );
  assert.equal(slices.length, 6, "five named, then Other");
  assert.equal(slices[5].label, "Other");
  assert.equal(slices[5].value, 2, "the tail is summed, not dropped");
  assert.equal(slices[0].value, 10, "biggest first");
  assert.equal(
    slices.reduce((t, s) => t + s.value, 0),
    32,
    "every piece of work is in the pie exactly once"
  );
  assert.equal(new Set(slices.map((s) => s.color)).size, 6, "no hue used twice");

  // A category nobody made anything in is not a zero-width slice.
  assert.equal(chart.toSlices(new Map([["a", 3], ["b", 0]])).length, 1, "empty ones are left out");
  assert.deepEqual(chart.toSlices(new Map()), [], "and nothing at all is nothing");

  // Identity never rests on colour alone — this prints in black and white, and
  // the tritan separation between two of the hues is inside the band that is
  // only legal with a second channel.
  const doc = read("components/document.tsx");
  assert.match(doc, /function Legend/, "there is a legend");
  assert.match(doc, /\{s\.label\}/, "with the name of every slice");
  assert.match(doc, /Math\.round\(\(s\.value \/ total\) \* 100\)/, "and its share");
  ok("the pie: five hues plus Other, biggest first, every slice named and shared");
}

/* ---------------- an invoice that adds up ---------------- */
{
  const clientId = Number(
    (await db.execute(
      "INSERT INTO clients (company_name, status, contact_person, phone) VALUES ('ZZ doc client','active','ZZ Person','99999 00000')"
    )).insertId
  );

  const mk = async (no, amount, tax, fee, total, lineItems) =>
    Number(
      (await db.execute(
        `INSERT INTO invoices (invoice_no, client_id, amount, tax, processing_fee, total,
                               status, issue_date, due_date, period_month, line_items)
         VALUES (?,?,?,?,?,?,'sent','2026-08-01','2026-08-10','2026-08',?)`,
        [no, clientId, amount, tax, fee, total, lineItems]
      )).insertId
    );

  const withLines = await mk(
    "ZZ-DOC-1", 20000, 3600, 650, 24250,
    JSON.stringify([
      { description: "Retainer", qty: 1, rate: 20000 },
      { description: "Processing fee", qty: 1, rate: 650 },
    ])
  );
  const doc = await payments.getInvoiceDocument(withLines);
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.total, 24250);
  assert.equal(doc.company_name, "ZZ doc client");
  assert.equal(doc.contact_person, "ZZ Person", "the client's own details are on it");

  const subtotal = doc.lines.reduce((t, l) => t + l.qty * l.rate, 0);
  assert.equal(subtotal + doc.tax, doc.total, "lines + tax = total, so the columns add up");

  /*
   * The case the "Other charges" row exists for: an invoice written before
   * `line_items`, where the only line is the amount and the processing fee is
   * nowhere in the column. A document about money that does not add up to its
   * own total is the one thing this must never print.
   */
  const legacy = await mk("ZZ-DOC-2", 10000, 1800, 500, 12300, null);
  const old = await payments.getInvoiceDocument(legacy);
  assert.equal(old.lines.length, 1, "it still has a line to show");
  assert.equal(old.lines[0].rate, 10000);
  const gap = Math.round((old.total - old.tax - old.lines[0].rate) * 100) / 100;
  assert.equal(gap, 500, "and the fee it cannot see is exactly what the extra row shows");
  assert.match(read("app/invoice/[id]/page.tsx"), /Other charges/, "which the page prints");

  /*
   * JSON that is valid but is not a list of lines.
   *
   * The column is a real JSON type, so MySQL refuses to store anything
   * malformed — but it will happily store an empty list or an object, and
   * either would otherwise print a blank page where the charge should be.
   */
  for (const [no, stored] of [
    ["ZZ-DOC-3", '{"note":"not a list"}'],
    ["ZZ-DOC-4", "[]"],
  ]) {
    const id = await mk(no, 5000, 0, 0, 5000, stored);
    const b = await payments.getInvoiceDocument(id);
    assert.equal(b.lines.length, 1, `${no}: there is still a line`);
    assert.equal(b.lines[0].rate, 5000, `${no}: it falls back to the amount`);
  }

  assert.equal(await payments.getInvoiceDocument(99999999), null, "an invoice that isn't there");
  ok("an invoice carries its lines, its client, and always adds up to its own total");
}

/* ---------------- the client is actually sent the link ---------------- */
{
  const report = await load("lib/monthly-report.ts");
  const summary = {
    clientId: 1, client: "ZZ Cafe", month: "2026-07", monthLabel: "July 2026",
    content: { planned: 12, delivered: 10, approved: 12 },
    posts: null, audience: [], ads: null,
  };

  /*
   * A link only where a file cannot follow.
   *
   * The send-by-hand path attaches the PDF to the same group a second later,
   * so its message carries no link — pointing at a document the client already
   * has is noise in something read on a phone. The scheduled batch goes
   * through the outbox, which sends text and nothing else, so that one still
   * needs somewhere to point.
   */
  const byHand = read("app/(app)/reports/[id]/actions.ts");
  assert.match(byHand, /body: renderReportText\(report\),/, "the message sent by hand has no link");
  assert.match(byHand, /url: reportLink\(clientId, month\)/, "the file is rendered from it instead");

  const batch = read("lib/monthly-report.ts");
  assert.match(
    batch,
    /body: renderReportText\(report, reportLink\(c\.id, month\)\)/,
    "the queued batch, which cannot attach anything, still carries a link"
  );

  const withLink = report.renderReportText(summary, "https://example.com/report/1?k=abc");
  assert.match(withLink, /https:\/\/example\.com\/report\/1\?k=abc/, "and it appears when passed");
  assert.match(withLink, /full report/i, "and says what it is");

  const bare = report.renderReportText(summary);
  assert.ok(!/undefined|null/.test(bare), "no link, no debris");
  assert.ok(!/full report/i.test(bare), "and no empty section where one would have been");
  assert.ok(!/https?:\/\//.test(bare.replace(/Best performing post.*/g, "")), "nothing to tap at all");

  const messages = await load("lib/reminder-messages.ts");
  const one = messages.invoiceText([
    {
      invoice_no: "INV-1", total: 5000, due_date: "2026-08-10",
      payUrl: "https://pay.example/x", payable: true,
      docUrl: "https://example.com/invoice/12?k=abc",
    },
  ]);
  assert.match(one, /https:\/\/pay\.example\/x/, "where to pay");
  assert.match(one, /https:\/\/example\.com\/invoice\/12\?k=abc/, "and the invoice itself");

  // The person who taps the pay link is rarely the one who files the invoice,
  // but a chase with no document link must not grow an empty section.
  const noDoc = messages.invoiceText([
    { invoice_no: "INV-1", total: 5000, due_date: null, payUrl: "https://pay.example/x", payable: true },
  ]);
  assert.ok(!/undefined|null/.test(noDoc), "no document, no debris");
  ok("the message a client receives carries the document, and reads properly without one");
}

/* ---------------- and the file itself lands in the group ---------------- */
{
  const client = read("lib/whatsapp-service-client.ts");
  assert.match(client, /\/api\/send-document/, "the portal asks the service to render and send");
  // A render plus an upload is not a text send; the default timeout would cut
  // it off partway and report a failure for something that went.
  assert.match(client, /timeoutMs: 120_000/, "and waits long enough for both");

  const service = readFileSync(
    `${SRC}/../../whatsapp-service/src/routes/index.js`,
    "utf8"
  );
  assert.match(service, /router\.post\('\/api\/send-document'/, "the service has the endpoint");
  /*
   * The guard that matters most here. Without it, anything holding the service
   * key could point a browser inside that network at any address — a cloud
   * metadata endpoint, an admin page on localhost — and have the rendered
   * result posted into a client's WhatsApp group.
   */
  assert.match(service, /url\.startsWith\(`\$\{config\.portal\.url\}\/`\)/, "only the portal's own pages");
  assert.match(service, /router\.use\('\/api', requireKey\)/, "and only the portal may ask");

  const pdf = readFileSync(`${SRC}/../../whatsapp-service/src/lib/pdf.js`, "utf8");
  // Printed, not screenshotted: without this the client's invoice arrives with
  // a "Save as PDF" button on it.
  assert.match(pdf, /emulateMediaType\('print'\)/, "the print rules are what is rendered");
  assert.match(pdf, /printBackground: true/, "the brand rule and the chart slices survive");
  assert.match(pdf, /preferCSSPageSize: true/, "the page's own @page wins");
  assert.match(pdf, /networkidle0/, "the logo and fonts have arrived before it prints");
  // A browser left open is 200 MB the WhatsApp session needs, and two at once
  // on a 1 vCPU box is how the kernel starts choosing what to kill.
  assert.match(pdf, /finally \{/, "the browser is closed on every path");
  assert.match(pdf, /let chain = Promise\.resolve\(\)/, "one render at a time");
  assert.ok(
    !/pupBrowser|pupPage/.test(pdf),
    "it does not borrow the WhatsApp session's browser, which shares one renderer"
  );

  const send = read("app/(app)/reports/[id]/actions.ts");
  const markAt = send.indexOf("markReportSent(");
  const docAt = send.indexOf("sendDocumentToGroup(");
  assert.ok(markAt > 0 && docAt > markAt, "the month is marked sent before the file is attached");
  // A failed attachment on a report the client has already received is a
  // partial success, not a failure — and the message still carries the link.
  assert.match(send, /didn't attach/, "an attachment that fails says so without crying wolf");
  assert.match(
    send,
    /ok: true,\s*\n\s*message: `The message went to/,
    "and still reports the report as sent, because it was"
  );
  ok("the PDF is rendered from the client's own link and attached after the message");
}

await clean();
await finish(pass);
