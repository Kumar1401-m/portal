/**
 * Whose leads these are.
 *
 * A lead exists because an ad ran for somebody, and the board showed every
 * client's in one list. Fine for a solo operator; useless to an agency, where
 * the question is always "what did this month get *them*?" — and unanswerable,
 * because the filters were stage, owner and a search box, and none of those
 * knows which client an enquiry belongs to.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const leads = await import(pathToFileURL(`${SRC}/lib/leads.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

{
  const clean = async () => {
    await db.execute("DELETE FROM leads WHERE name LIKE 'ZZ lead%'");
    await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ leadclient%'");
  };
  await clean();
  const mk = async (n) =>
    Number((await db.execute(
      "INSERT INTO clients (company_name, status) VALUES (?, 'active')", [n]
    )).insertId);
  try {
    const a = await mk("ZZ leadclient A");
    const b = await mk("ZZ leadclient B");
    for (const [name, cid] of [["ZZ lead one", a], ["ZZ lead two", a], ["ZZ lead three", b]]) {
      await db.execute(
        "INSERT INTO leads (name, stage, source, client_id) VALUES (?, 'new', 'ads', ?)",
        [name, cid]
      );
    }

    const mine = (rows) => rows.filter((r) => r.name.startsWith("ZZ lead"));

    const all = mine(await leads.getLeads({}));
    assert.equal(all.length, 3, "unfiltered, every client's leads are there");

    const justA = mine(await leads.getLeads({ clientId: a }));
    assert.equal(justA.length, 2, "one client's board holds only their leads");
    assert.ok(justA.every((l) => l.client_name === "ZZ leadclient A"), "and says whose they are");

    // A crm sees the clients they are on, and no others.
    const scoped = mine(await leads.getLeads({ clientIds: [b] }));
    assert.equal(scoped.length, 1, "a scoped user sees only their clients' leads");
    assert.equal(scoped[0].name, "ZZ lead three");

    // An empty scope is nobody's leads, not everybody's.
    assert.equal((await leads.getLeads({ clientIds: [] })).length, 0, "and an empty scope shows none");
  } finally {
    await clean();
  }
  ok("leads filter to one client, and a scoped user sees only theirs");
}

await finish(pass);
