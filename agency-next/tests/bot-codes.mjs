/**
 * The code the assistant quotes is the code that works.
 *
 * A video's code is issued by `ensureVideoCode` from its own counter the first
 * time the video is sent for approval, stored in `deliverables.video_code`,
 * and `findByVideoCode` — the only way a reply is matched back to a video —
 * looks at that column and nothing else.
 *
 * The assistant built its own from the row id instead. So it told a client
 * "V179955" for a video whose code is "V901", and then, following its own
 * instructions, asked them to reply "APPROVE V179955". That command matches no
 * row: the approval does nothing, silently, and the client is left believing
 * they have approved it. Found by running the assistant against a fixture and
 * reading what it actually said.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-ai.ts`).href);
const approvals = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * What it quotes, and what the parser accepts
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ code %'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ code test'");
  };
  await clean();

  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ code test','active')")).insertId
  );
  const sent = Number(
    (await db.execute(
      "INSERT INTO deliverables (client_id, title, status, video_code) VALUES (?,'ZZ code sent','review','ZZ901')",
      [cid]
    )).insertId
  );
  const unsent = Number(
    (await db.execute(
      "INSERT INTO deliverables (client_id, title, status) VALUES (?,'ZZ code unsent','editing')",
      [cid]
    )).insertId
  );

  try {
    const facts = await wa.clientFacts(cid);
    assert.ok(facts, "the client's facts load");

    const byTitle = Object.fromEntries(facts.items.map((i) => [i.title, i]));
    assert.equal(byTitle["ZZ code sent"].code, "ZZ901", "a sent video is quoted by its own code");

    /*
     * And the code it quotes actually resolves. This is the whole point: the
     * row id and the code are different numbers, and only one of them is
     * something the client can type.
     */
    const found = await approvals.findByVideoCode(byTitle["ZZ code sent"].code);
    assert.ok(found, "the quoted code matches a video");
    assert.equal(found.id, sent, "and it is the right one");
    assert.notEqual(String(sent), "901", "the id and the code are not the same number");

    /*
     * A video that has never been sent has no code, and the honest answer is
     * to have none. Inventing one would put a number in front of a client
     * that they have never seen and cannot use.
     */
    assert.equal(byTitle["ZZ code unsent"].code, null, "an unsent video has no code to quote");
    assert.ok(unsent > 0, "and it is still listed, by title");

    const src = read("lib/whatsapp-ai.ts");
    assert.ok(!src.includes("code: `V${r.id}`"), "no code is built from a row id");
    assert.ok(src.includes("code: r.video_code,"), "it comes from the column the parser reads");
    assert.ok(
      src.includes('`- ${i.code ? `${i.code} ` : ""}"${i.title}"'),
      "and a missing one is left out rather than faked"
    );
    ok("the assistant quotes the code a client can actually reply with");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * A second attempt is only a second chance if it differs
 * ------------------------------------------------------------------ */
{
  /*
   * The fallback exists so a rate-limited or failing model gets one more go
   * on a smaller one. Configured to the same model — which is the default —
   * it repeated the call that had just failed, for the same reason, and the
   * client waited twice as long for the same holding line while the retry
   * spent another slice of the quota that caused it.
   */
  const src = read("lib/whatsapp-ai.ts");
  const guardAt = src.indexOf("if (env.gemini.fastModel === env.gemini.model) return null;");
  const secondAt = src.indexOf("const second = await attempt(env.gemini.fastModel");
  assert.ok(guardAt > 0, "an identical fallback is not attempted");
  assert.ok(secondAt > guardAt, "the guard comes before the second call");

  const retriableAt = src.indexOf("if (!first.retriable) return null;");
  assert.ok(retriableAt > 0 && guardAt > retriableAt, "and a permanent failure still stops first");
  ok("the client is not made to wait twice for the same failure");
}

await finish(pass);
