/**
 * Who gets an email, and who gets the bell.
 *
 * Every admin notification the portal raises used to be mailed to every admin
 * as well — a post published, a poster submitted, footage arriving, a client
 * asking a question, each decision the night shift made. All of them were
 * already in the bell, which is where somebody looks when they are working.
 * An inbox filled with copies of the bell stops being read, and then the one
 * that mattered — a reel that failed to publish on a client's account — lands
 * looking exactly like the rest of them.
 *
 * So the bell is the default and email is a decision. This is the list of
 * decisions, and it is meant to stay short.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import fs2 from "node:fs";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => fs2.readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the bell is the default ---------------- */
{
  const notify = read("lib/notify.ts");
  const admins = notify.split("export async function notifyAdmins(")[1].split(/^}/m)[0];
  assert.ok(admins.includes("mail = false"), "notifyAdmins does not mail unless asked");
  assert.ok(
    admins.includes("mail ? a.email : null"),
    "and the flag is what decides the address, not merely present in the signature"
  );
  ok("an admin notification is a bell entry until somebody says otherwise");
}

/* ---------------- and the exceptions are counted ---------------- */
{
  /*
   * Grep rather than a registry: a caller opts in by passing `true`, and the
   * point of this check is that adding one is a visible act. If this list
   * grows past a handful the inbox is on its way back to being ignored.
   */
  const FILES = [
    "app/(app)/deliverables/actions.ts", "app/(app)/poster/actions.ts",
    "app/api/whatsapp/footage/route.ts", "app/api/whatsapp/message/route.ts",
    "app/portal/actions.ts", "lib/instagram-publish.ts", "lib/instagram.ts",
    "lib/whatsapp-approvals.ts", "lib/whatsapp-reminders.ts", "lib/decisions.ts",
  ];
  const mailed = [];
  for (const rel of FILES) {
    const src = read(rel);
    for (const chunk of src.split("notifyAdmins(").slice(1)) {
      const args = chunk.split(");")[0];
      const lines = args.split(String.fromCharCode(10)).map((x) => x.trim());
      if (lines.includes("true") || lines.includes("true,")) mailed.push(rel);
    }
  }
  assert.deepEqual(
    mailed,
    ["lib/instagram.ts"],
    "only a failed publish is worth an admin's inbox; everything else is in the bell"
  );
  ok("exactly one admin notification still sends mail, and it is the failed post");
}

await finish(pass);
