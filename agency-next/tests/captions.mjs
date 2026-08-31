/**
 * What actually goes out under the video.
 *
 * Two faults, and the same root: the caption was written into two columns and
 * then joined from both. The analysis stored the hashtags inside `caption` as
 * well as in `hashtags`, and `composeCaption` — whose only job is putting the
 * two together for Instagram — appended them again. Every published reel
 * carried its hashtags twice, on a client's account, and the studio showed the
 * doubled copy back as though a person had written it that way.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the tags go out once ---------------- */
{
  const tags = "#freskos #freskoscoffeedosafood #dosa #filtercoffee #vizag";
  const body = "Fresh filter coffee, every morning.";

  assert.equal(ig.composeCaption(body, tags), `${body}\n\n${tags}`, "written once, joined once");

  // The rows already stored the doubled way — the body ends with its own tags.
  assert.equal(
    ig.composeCaption(`${body}\n\n${tags}`, tags),
    `${body}\n\n${tags}`,
    "a body that already ends in its tags is not given them again"
  );
  // Whichever spacing the two paths used to join them with.
  assert.equal(
    ig.composeCaption(`${body}\n${tags}`, tags),
    `${body}\n${tags}`,
    "regardless of the whitespace between"
  );
  // And a body that merely mentions one of them is still owed its block.
  const partial = `${body} we love #dosa`;
  assert.equal(
    ig.composeCaption(partial, tags),
    `${partial}\n\n${tags}`,
    "a body that mentions a tag has not been given the block"
  );
  ok("hashtags are published once, however many times they were stored");
}

/* ---------------- six or seven tags, and which ---------------- */
{
  /*
   * The client, the account, the city and the country are built by the
   * portal, not asked for. It knows all four exactly; a model asked for a
   * handle returns a plausible spelling of one — a tag belonging to a
   * stranger, posted on this client's account — and a guessed city is worse,
   * because it looks right to everybody who does not live there.
   */
  const src = readFileSync(`${SRC}/lib/video-ai.ts`, "utf8");

  for (const field of ["d.company_name", "d.ig_username", "ctx?.city"]) {
    assert.ok(src.includes(`tag(${field})`), `${field} comes from the portal, not the model`);
  }
  assert.ok(src.includes("tag(s(parsed.video_keyword))"), "and the fourth is two or three words from the video");
  assert.ok(
    src.includes("business name, not its handle, not its city"),
    "and told not to repeat the three the portal supplies"
  );

  // One bracket with commas — not a bracket each, which reads as debris.
  assert.ok(src.includes("const chosen = ["), "one array feeds the keywords and the tags");
  assert.ok(
    src.includes('.join(", ")') && src.includes(".slice(1)"),
    "the keywords are the tags without their hash, comma separated in one bracket"
  );

  // The caption itself.
  assert.match(src, /THREE lines about the video, and no more/, "three lines, no more");
  assert.match(src, /Use the branding you read off the screen/, "read from the logo and footer");
  assert.ok(
    src.includes("Never attribute a") && src.includes("logo or a footer to a business other than"),
    "and never to the wrong business"
  );
  // Asked for rather than rationed: a caption with none reads like a notice,
  // and the old cap of "one or two" produced captions with one.
  assert.ok(src.includes("USE EMOJI."), "emoji are asked for");
  assert.ok(src.includes("never on a price, an interest rate"), "but never where they read as a promise");
  assert.match(src, /Then a contact line/, "then the contact details");
  ok("the brand, the account, the town, and what the video is about");
}

await finish(pass);
