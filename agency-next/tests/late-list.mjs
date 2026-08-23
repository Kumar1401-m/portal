/**
 * "Going to be late", about a client nobody works for any more.
 *
 * Archiving a client keeps the money and deletes the work — but their
 * unfinished tasks are rows like any other, and this panel joined `clients`
 * only to read the name off it. So twelve videos for a client last worked on
 * months ago sat at the top of the list that is supposed to say what needs
 * doing today, and nothing anybody did could clear them: the work is never
 * going to be done.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

{
  const panel = readFileSync(`${SRC}/app/(app)/team/workload-panel.tsx`, "utf8");
  assert.ok(panel.includes("onTheFloor()"), "the late list asks whether the client is still a client");
  assert.ok(
    panel.indexOf("onTheFloor()") < panel.indexOf("d.status IN ('pending'"),
    "before it asks anything about the task"
  );
  assert.ok(
    panel.includes('from "@/lib/client-status"'),
    "using the same rule as every other board, not a copy of it"
  );
  ok("an archived client's work is not on anybody's late list");
}

{
  /*
   * The rule itself, so this test fails if "on the floor" ever quietly stops
   * meaning what the panel is relying on it to mean.
   */
  const cs = readFileSync(`${SRC}/lib/client-status.ts`, "utf8");
  for (const s of ["churned", "inactive", "paused"]) {
    assert.ok(cs.includes(`"${s}"`), `${s} is off the floor`);
  }
  ok("and paused and inactive count as off the floor, not only churned");
}

await finish(pass);
