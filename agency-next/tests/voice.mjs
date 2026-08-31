/**
 * How the portal speaks to a client.
 *
 * Every one of these messages goes out with the agency's name on it and
 * without a person having read it first. Two rules, and they are the whole
 * test: anything we want from a client is asked for rather than instructed,
 * and a question we cannot answer is still answered.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const rm = await load("lib/reminder-messages.ts");
const ai = await load("lib/whatsapp-ai.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/**
 * Words that turn a request into an order when they open a sentence, and the
 * flat statements that read as a complaint about the client.
 */
const BLUNT = [
  /^\s*Send (?:us|me|the)/im,
  /^\s*Reply\b/im,
  /^\s*Pay\b/im,
  /\bYou (?:must|need to|have to|should)\b/i,
  /\bas soon as possible\b/i,
  /\bstill waiting on \d+ more\b/i,
  /\bASAP\b/,
];

const politeEnough = (text, label) => {
  for (const re of BLUNT) {
    assert.ok(!re.test(text), `${label} reads as an instruction: ${re} matched\n---\n${text}\n---`);
  }
  assert.match(
    text,
    /\b(please|thank you|whenever|could you|do let us know|happy to)\b/i,
    `${label} has nothing courteous in it:\n---\n${text}\n---`
  );
};

/* ---------------- every reminder asks rather than tells ---------------- */
{
  const cases = [
    ["footage, one date", rm.footageText([{ title: "Diwali reel", due_date: "2026-09-01" }])],
    [
      "footage, mixed dates",
      rm.footageText([
        { title: "Reel A", due_date: "2026-09-01" },
        { title: "Reel B", due_date: "2026-09-04" },
      ]),
    ],
    ["approval, one", rm.approvalChaseText([{ title: "Diwali reel", video_code: "V1" }])],
    [
      "approval, several",
      rm.approvalChaseText([
        { title: "Reel A", video_code: "V1" },
        { title: "Reel B", video_code: "V2" },
      ]),
    ],
    ["month plan", rm.monthlyPlanText([{ title: "Reel A", due_date: "2026-09-01" }])],
    [
      "invoice, payable",
      rm.invoiceText([
        { invoice_no: "INV-1", total: 5000, due_date: "2026-09-01", payUrl: "https://x", payable: true },
      ]),
    ],
    [
      "invoice, portal",
      rm.invoiceText([
        { invoice_no: "INV-1", total: 5000, due_date: null, payUrl: "https://x", payable: false },
      ]),
    ],
    [
      "invoices, several",
      rm.invoiceText([
        { invoice_no: "INV-1", total: 5000, due_date: null, payUrl: "https://x", payable: true },
        { invoice_no: "INV-2", total: 7000, due_date: null, payUrl: "https://y", payable: true },
      ]),
    ],
  ];
  for (const [label, text] of cases) politeEnough(text, label);
  ok(`all ${cases.length} client reminders ask rather than instruct`);
}

/* ---------------- the team's own digest is exempt ---------------- */
{
  const digest = rm.teamDigestText([{ company_name: "A", title: "T", due_date: "2020-01-01" }], 2, "2026-08-11");
  assert.ok(!/please|thank you/i.test(digest), "the team digest stays terse — it is not a client message");
  ok("the message that goes to the agency's own group is left alone");
}

/* ---------------- the welcome thanks them for coming ---------------- */
{
  const w = ai.welcomeMessage("Acme", "NVK");
  politeEnough(w, "welcome");
  assert.match(w, /Thank you for choosing NVK/);
  assert.match(w, /\*OK\*/, "and still teaches the exact words the parser needs");
  assert.match(w, /\*CHANGE\*/);
  ok("the welcome message thanks them and still teaches the commands");
}

/* ---------------- a question we cannot answer is still answered ---------------- */
{
  const held = ai.holdingReply("Ravi Kumar");
  assert.match(held, /Thank you, Ravi!/, "it uses their first name, not their whole name");
  assert.match(held, /someone will get back to you/i);
  assert.ok(
    !/didn't understand|did not understand|sorry, I/i.test(held),
    "and never tells a client their question was the problem"
  );
  assert.match(ai.holdingReply(null), /Thank you for your message/, "no name, still courteous");
  assert.match(ai.holdingReply("  "), /Thank you for your message/, "blank name is no name");
  ok("an unanswerable question gets a thank-you and a person, not silence");

  // The promise has to be backed by something. Without this the holding line
  // is just a politer way of ignoring them.
  const route = read("app/api/whatsapp/message/route.ts");
  assert.match(
    route,
    /if \(!composed\) \{[\s\S]{0,400}notifyAdmins/,
    "and the team is told, so a person actually does come back"
  );
  ok("the promise of a reply is backed by a notification to the team");
}

/* ---------------- the model is told to be courteous ---------------- */
{
  const src = read("lib/whatsapp-ai.ts");
  assert.match(src, /Be respectful and courteous in every reply/);
  assert.match(src, /Ask, never instruct/);
  assert.match(src, /do not say you don't understand/i, "an unknown answer is 'let me check', not a shrug");
  assert.match(src, /Match the language they wrote in/, "including when the client writes in Telugu");
  ok("the auto-reply is instructed on tone as firmly as it is on facts");
}

/* ---------------- and so are the service's own acknowledgements ---------------- */
{
  const router = readFileSync(`${SRC}/../../whatsapp-service/src/lib/message-router.js`, "utf8");
  const acks = router.slice(router.indexOf("async acknowledge("), router.indexOf("async replySafely("));
  // One branch now — content is not sent to a client, so a video is the only
  // thing they are ever asked to approve. Asserted on the intent rather than
  // the exact sentence, which has been rewritten once already and will be again.
  const approvals = acks.match(/✅ Thank you!/g) || [];
  assert.equal(approvals.length, 1, "an approval is thanked for");
  assert.ok(!/Thank you! \*?\$\{ref\}/.test(acks), "and neither opens with a code the client never saw");
  assert.match(acks, /Thank you — noted/, "so is a change request");
  assert.ok(!/We'll follow up with you\.`/.test(acks), "and a rejection says who follows up, and when");
  assert.match(router, /Sorry — we couldn't record that/, "a failure apologises rather than warns");
  assert.ok(
    !/⚠️ Couldn't record that/.test(router),
    "the blunt version is gone, not merely joined by a polite one"
  );
  ok("the WhatsApp service thanks the client for every command it records");
}

/* ---------------- a voice note comes back twice: as said, and in English ---------------- */
{
  const route = read("app/api/whatsapp/transcribe/route.ts");
  const router = readFileSync(`${SRC}/../../whatsapp-service/src/lib/message-router.js`, "utf8");

  /*
   * The transcript comes from a model that CANNOT do anything but transcribe.
   *
   * It used to be one general-purpose call asked, in the prompt, to return the
   * words untouched alongside a translation. That request was always honoured
   * and never guaranteed — and the failure it guards against is severe: a model
   * that helpfully returns "The client is approving the video" instead of
   * "sare" breaks approval outright, because the parser is looking for the
   * word, not the meaning.
   *
   * A dedicated transcription endpoint cannot paraphrase. That is now a
   * property of the model rather than a hope about the prompt.
   */
  assert.ok(route.includes("transcribeBlob("), "the words come from a transcription model");
  assert.ok(
    route.includes("do not translate, summarise, answer or explain it") ||
      route.includes("Do not answer it, summarise it or comment on it."),
    "and the translator is told to leave the sentence alone"
  );

  /*
   * The container is decided by the filename, and only by the filename.
   *
   * OpenAI ignores the multipart content type. WhatsApp sends audio/ogg with
   * opus inside; `.opus` and `.oga` are both refused outright and `.ogg` is
   * accepted, which is not guessable and was checked against the live API. Get
   * this wrong and every voice note in the system fails identically.
   */
  assert.ok(route.includes('"audio/ogg": "ogg"'), "a WhatsApp voice note is named .ogg");
  assert.ok(!route.includes('"opus"'), "never .opus, which the API rejects");

  /*
   * Losing the translation costs a person one click to play the note back;
   * losing the transcript would cost the client their approval. So the
   * translation is a separate call that is allowed to fail on its own.
   */
  assert.ok(route.includes("if (t.ok) english"), "a failed translation still yields a transcript");
  assert.ok(
    route.includes('console.warn("[whatsapp] translation failed:'),
    "loudly"
  );

  // A client who spoke English would otherwise have their sentence printed
  // twice in the timeline, once labelled as a translation of itself.
  assert.match(route, /english && english !== text \? english : ""/, "an identical translation is dropped");

  /*
   * The split that matters. `body` is what the parser, the intent model and
   * the transcript all read as the client's own words, so it stays in their
   * language; the English is appended only where a person reads it. Putting
   * the translation on `body` would hand two languages to a parser looking
   * for the word "ok".
   */
  assert.match(router, /body: spoken\.text, english: spoken\.english/, "their words stay on the message");
  assert.match(
    router,
    /message: msg\.english \? `\$\{msg\.body\}\\n\\n🗣 English: \$\{msg\.english\}` : msg\.body/,
    "and the translation is appended for the transcript only"
  );
  assert.ok(
    !/body: spoken\.english/.test(router),
    "nothing downstream is ever handed the translation as the message"
  );

  // Half an answer is still worth having: no translation must not lose the words.
  assert.match(router, /typeof english === 'string' \? english\.trim\(\) : ''/, "a missing translation is empty, not fatal");
  ok("a Telugu voice note is parsed in Telugu and read in English");
}

await finish(pass);
