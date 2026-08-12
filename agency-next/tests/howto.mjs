/**
 * The message that teaches a client group what to say.
 *
 * Its one real risk is drift: it prints the exact words the parser accepts,
 * and a client following our own instructions and being told they typed it
 * wrong is the worst outcome this message could have. So every command word
 * it prints is fed back through the real parser here.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const rm = await load("lib/reminder-messages.ts");

const require = createRequire(`${SRC}/../../whatsapp-service/package.json`);
const { parseCommand } = require("./src/lib/command-parser.js");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const text = rm.howToAskText("4insite studio");

/* ---------------- it greets them and thanks them ---------------- */
{
  assert.match(text, /^Hello 4insite studio! 👋/, "it opens with their name");
  assert.match(rm.howToAskText(null), /^Hello! 👋/, "and works without one");
  assert.match(rm.howToAskText(), /^Hello! 👋/);
  assert.match(text, /Thank you! 🙏$/, "and closes courteously, like every other client message");
  ok("it greets the client by name when there is one, and thanks them either way");
}

/* ---------------- every word it teaches actually works ---------------- */
{
  // Pulled out of the message itself rather than typed here, so the test reads
  // what a client would read.
  const bolded = [...text.matchAll(/\*([A-Za-z]+)\*/g)].map((m) => m[1]);
  assert.ok(bolded.includes("OK"), "the message teaches OK");
  assert.ok(bolded.includes("CHANGE"), "and CHANGE");
  assert.ok(bolded.includes("raw"), "and raw");
  assert.ok(bolded.includes("status"), "and status");

  assert.equal(parseCommand("OK").command, "approve", "OK approves");
  assert.equal(parseCommand("CHANGE make it shorter").command, "change");
  assert.equal(
    parseCommand("CHANGE make it shorter").comment,
    "make it shorter",
    "and what follows reaches the editor"
  );
  assert.equal(parseCommand("status").command, "status");
  const raw = parseCommand("raw https://example.com/a.zip");
  assert.equal(raw.command, "footage", "raw in front of any link marks it as footage");
  assert.equal(raw.link, "https://example.com/a.zip");
  ok("every command word the message prints is one the parser accepts");
}

/* ---------------- the examples it offers are questions, not commands ---------------- */
{
  const examples = [...text.matchAll(/^• _(.+)_$/gm)].map((m) => m[1]);
  assert.ok(examples.length >= 4, `it offers real examples, got ${examples.length}`);
  for (const q of examples) {
    assert.equal(
      parseCommand(q).command,
      "none",
      `"${q}" must reach the assistant, not trip a command — it parsed as ${parseCommand(q).command}`
    );
  }
  ok(`all ${examples.length} "just ask" examples fall through to the assistant, as promised`);
}

/* ---------------- it is sendable from the console ---------------- */
{
  const entry = rm.SENDABLE.find((s) => s.kind === "how_to_ask");
  assert.ok(entry, "it appears in the reminders console");
  assert.equal(entry.perClient, true, "sent to one client's group, like the rest");
  assert.match(entry.label, /What you can ask us/);
  ok("a super admin can send it to any group, now or at a time they pick");
}

/* ---------------- the settings page documents the same thing ---------------- */
{
  const guide = readFileSync(`${SRC}/app/(app)/settings/whatsapp/keywords.tsx`, "utf8");
  assert.match(guide, /Anything else they ask/, "the free-question section exists");
  assert.match(guide, /const ASKED/, "with real example answers");
  // The page quotes the replies a client gets. They were reworded; a page that
  // still quotes the old ones is documentation that lies.
  assert.ok(!/Thank you! We'll schedule it for posting/.test(guide), "no stale approval reply");
  assert.ok(!/📝 Noted — _title_\\nYour changes/.test(guide), "no stale change reply");
  assert.ok(!/Got it — thanks!/.test(guide), "no stale footage reply");
  assert.match(guide, /🙏 Thank you! We've received it/, "the footage reply matches the real one");
  assert.match(guide, /✅ Thank you! Approved/, "and so does the approval");
  ok("the settings page quotes the replies the portal actually sends");
}

await finish(pass);
