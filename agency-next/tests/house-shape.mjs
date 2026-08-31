/**
 * The shape every caption comes out in.
 *
 *   three lines about the video
 *
 *   the business's own details — its name, its contact details, and for food
 *   the dishes by name
 *
 *   (brand, handle, town, what the video is about)
 *
 *   #brand #handle #town #whatthevideoisabout
 *
 * "Open with a hook, then a few short lines" is what this replaces, and it
 * produced a different caption every time — a feed of them read as though
 * four people had written it.
 *
 * The last two blocks are not asked for. Three of the four keywords are
 * things the portal knows exactly, and a model asked for a handle returns a
 * plausible spelling of one — which is a tag belonging to a stranger, posted
 * on this client's own account. Both blocks are built from a single array so
 * that the words and the tags cannot drift apart.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ai = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * Three lines, then the details
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");

  assert.ok(
    src.includes("THREE lines about the video, and no more"),
    "three lines about the video, said as a number"
  );
  assert.ok(src.includes("Line three: who it"), "each of the three has a job");
  assert.ok(
    src.includes("Then a contact line: the business name"),
    "then who they are and how to reach them"
  );
  assert.ok(src.includes("NAME the dishes that appear in it"), "and for food, the dishes by name");

  /*
   * Only ones we already hold or can see on screen. An invented phone number
   * in a caption on a client's own account sends their customers to a
   * stranger, and it was observed on the very first run against a real client.
   */
  assert.ok(
    src.includes("ONLY if it is listed above or visible on screen"),
    "contact details are never invented"
  );

  // A client with an agreed shape of their own keeps it; the house shape is
  // the default, not an override.
  assert.ok(src.includes("const shape = brief.templateRule"), "one shape is chosen, not two offered");
  assert.ok(src.includes("    : HOUSE_SHAPE;"), "the house shape is what a client without one gets");
  assert.ok(
    src.includes("FOLLOW THE TEMPLATE ABOVE EXACTLY"),
    "and a client who has one still gets theirs"
  );

  /*
   * Instead of, never alongside.
   *
   * Both used to be in the prompt at once: the client's template saying
   * "reproduce this exactly", and the house shape four bullets later saying
   * "three lines, then a contact line". A model handed two shapes splits the
   * difference, so a client with an agreed template got something that was
   * neither — which reads as the template being ignored and is really the
   * template being argued with.
   */
  const houseAt = src.indexOf("THREE lines about the video, and no more");
  const rulesAt = src.indexOf("Rules for the caption:");
  assert.ok(houseAt > 0 && houseAt < rulesAt, "the house shape is a constant, not a rule in the prompt");
  assert.ok(
    src.split("THREE lines about the video, and no more").length === 2,
    "and it appears once, so it cannot be sent with a template"
  );

  /*
   * The hook rule sits outside the choice on purpose: whatever shape a
   * caption takes, its first line decides whether anybody reads the second.
   */
  assert.ok(src.includes("THE FIRST LINE IS THE HOOK"), "the hook rule applies to either shape");
  assert.ok(
    !src.includes("LINE ONE IS THE HOOK"),
    "and is not phrased as one of three, which a template may not have"
  );

  // A template that ends in its own hashtag line must not be reproduced —
  // that block is built from what the portal knows, and a second one carries
  // a plausibly misspelled handle.
  const ctx = read("lib/client-context.ts");
  assert.ok(
    ctx.includes("If the template ends with a keyword or hashtag line, LEAVE IT OUT."),
    "the template's own hashtag line is left to the portal"
  );
  /*
   * And line one is where the reach comes from.
   *
   * A description is a label: it tells somebody who already stopped what they
   * are looking at. A hook earns the reply, and a reply is what makes
   * Instagram show the reel to people who do not follow the account — which
   * is the difference between a post the client's followers see and a post
   * that finds new ones.
   */
  assert.ok(src.includes("THE FIRST LINE IS THE HOOK"), "the first line has a job of its own");
  assert.ok(
    src.includes("stop the scroll and earn a reply"),
    "and the job is a reply, not a description"
  );
  assert.ok(
    src.includes('"Fresh biryani at ZZ Foods" is a label'),
    "shown the difference by example, because the rule alone reads as advice"
  );
  assert.ok(
    src.includes(String.raw`never the business name`),
    "and told what a hook is not"
  );

  /*
   * The comment ask, which is the highest-leverage line in the whole caption
   * — and the one most easily turned into a lie. Asking people to comment
   * for a menu that does not exist costs the reply and the trust, which is
   * worse than no ask at all.
   */
  /*
   * The ask is triggered by the REEL, not by the caption writer's judgement.
   *
   * A lead-magnet reel ends by asking for a comment — "comment PRICE and
   * I'll send the list". That is a fact about the footage, in the transcript
   * or on the last frames, and it is the only thing that earns a comment ask
   * in the caption. The looser rule this replaces — "if the video offers the
   * viewer something" — was a judgement call, and a model asked to judge
   * whether an offer exists finds one.
   */
  assert.ok(src.includes("IS THIS REEL ASKING FOR A COMMENT?"), "the reel decides, not the writer");
  assert.ok(
    src.includes("Look at how it ENDS"),
    "and it is looked for where a lead magnet puts it"
  );
  assert.ok(
    src.includes("Use the SAME word the video used."),
    "the word is the video's own"
  );
  assert.ok(
    src.includes("word the business is watching for"),
    "because that is the word people will type and the business is watching for"
  );

  /*
   * And it goes first. The reel makes the ask in its last seconds, by which
   * point most people have scrolled; the caption is what the ones who stayed
   * are reading.
   */
  assert.ok(src.includes("that ask is the FIRST line of the caption"), "and it leads the caption");
  assert.ok(
    src.includes("EVERY OTHER REEL: no comment ask at all."),
    "every other reel is written normally"
  );
  assert.ok(
    src.includes("comment below"),
    "with the half-measure named, because that is what a model reaches for"
  );

  /*
   * Emoji are not decoration on Instagram — they are how a caption is read at
   * a glance, and a caption with none reads like a notice. The rule used to
   * cap them at "one or two", which produced captions with one.
   */
  assert.ok(src.includes("USE EMOJI."), "emoji are asked for, not merely permitted");
  assert.ok(src.includes("to five across the whole caption"), "with a range that is not zero");
  assert.ok(src.includes("📍 for the town"), "the contact line gets the ones that label it");
  assert.ok(
    src.includes("never on a price, an interest rate, a guarantee or a"),
    "and never on a number a regulator would read as a promise"
  );
  assert.ok(
    src.includes("If the client's template has emoji in it, use exactly those"),
    "a template's own emoji are part of the shape they agreed"
  );
  ok("line one earns the reply the reach depends on, and never promises what is not there");
}

/* ------------------------------------------------------------------ *
 * Four keywords, three of which are not guessed
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");

  assert.ok(
    src.includes("tag(d.company_name),\n    tag(d.ig_username),\n    tag(ctx?.city),\n    tag(s(parsed.video_keyword)),"),
    "brand, handle, town, and what the video is about — in that order"
  );

  /*
   * The model supplies exactly one of the four. It used to supply three
   * hashtags of its own choosing, which is where a misspelled handle and a
   * guessed city came from.
   */
  assert.ok(!src.includes("const fromVideo = arr(parsed.hashtags)"), "no tags of its own choosing");
  assert.ok(ai.CAPTION_SCHEMA.properties.video_keyword, "it is asked for the phrase instead");
  assert.ok(
    ai.CAPTION_SCHEMA.required.includes("video_keyword"),
    "and required to give one, as strict mode insists"
  );
  assert.ok(!ai.CAPTION_SCHEMA.properties.hashtags, "and no longer asked for hashtags at all");
  assert.ok(
    src.includes("Do NOT write the keyword line and do NOT write any hashtags."),
    "and told not to write either block"
  );

  /*
   * One array, read twice. Written apart they drift the first time somebody
   * changes how many there are, and a post whose words and tags disagree is
   * being optimised for two different things.
   */
  assert.ok(
    src.includes("`(${chosen.map((t) => t.slice(1)).join(\", \")})`"),
    "the bracket line is the keywords, comma separated"
  );
  assert.ok(src.includes("chosen.join(\" \"),"), "and the hashtags are the same array");
  /*
   * Run on real strings, because this is where it actually broke.
   *
   * The regex was /[^p{L}p{N}]/gu and lost both backslashes. Inside a
   * character class "p{L}" is five literal characters, not a unicode property
   * — so the negated set kept only p, {, L, } and N and deleted the rest.
   * "Freskos" came out empty, "Liverpool" came out "Lp", and an empty tag
   * returns null. Every keyword was dropped, the array was empty, and every
   * caption published with no keyword line and no hashtags at all.
   *
   * Nothing about that is visible in the source: the regex reads correctly
   * until you run it. A source-text assertion would have agreed with it.
   */
  assert.equal(ai.hashTag("Freskos"), "#freskos", "a plain name survives");
  assert.equal(ai.hashTag("Liverpool"), "#liverpool", "so does a town");
  assert.equal(ai.hashTag("freskos_liverpool"), "#freskosliverpool", "punctuation goes");
  assert.equal(ai.hashTag("double fried fries"), "#doublefriedfries", "and so do the spaces");
  assert.equal(ai.hashTag("బిర్యానీ"), "#బిర్యానీ", "a Telugu tag is letters too");
  assert.equal(ai.hashTag("ZZ 2026"), "#zz2026", "digits stay");
  assert.equal(ai.hashTag("!!!"), null, "and something with no letters at all is no tag");
  assert.equal(ai.hashTag(null), null, "nor is nothing");
  ok("the keyword line and the hashtags are the same four things, and cannot drift");
}

/* ------------------------------------------------------------------ *
 * And they land at the end, once
 * ------------------------------------------------------------------ */
{
  const body = "Three lines here.\nSecond line.\nThird line.\n\nZZ Foods · 90000 00000";
  const tail = "(zzfoods, zzfoods_hyd, hyderabad, chicken biryani)\n#zzfoods #zzfoods_hyd #hyderabad #chickenbiryani";

  assert.equal(
    ig.composeCaption(body, tail),
    `${body}\n\n${tail}`,
    "the keyword line and the tags go under the caption, separated by a blank line"
  );
  assert.equal(
    ig.composeCaption(`${body}\n\n${tail}`, tail),
    `${body}\n\n${tail}`,
    "and never twice, however many times they were stored"
  );
  /*
   * And they are part of the caption that is shown, not only of the one that
   * publishes.
   *
   * The two halves live in separate columns, and the caption panel reads only
   * the first — so a caption with its keyword line and hashtags sitting in
   * `hashtags` looked, on screen, exactly like a caption that had neither.
   * Copy handed over an incomplete post, and the only way to find out was to
   * publish one.
   */
  const src = read("lib/video-ai.ts");
  assert.ok(
    src.includes("caption: composeCaption(checked.caption, hashtags),"),
    "the writer returns the caption that will actually be posted"
  );
  assert.ok(
    src.includes("composeCaption(a.caption, a.hashtags),"),
    "and that is what is stored on the task"
  );

  /*
   * Which means it gets composed a second time on the way out, and must not
   * double. This is the round trip, run for real.
   */
  const once = ig.composeCaption(body, tail);
  assert.equal(ig.composeCaption(once, tail), once, "composing an already-composed caption changes nothing");
  ok("the blocks are added under the caption exactly once, and are visible before it is sent");
}

/* ------------------------------------------------------------------ *
 * Nothing goes to the client until there is a caption
 * ------------------------------------------------------------------ */
{
  const modal = read("app/(app)/deliverables/edit-video-modal.tsx");

  /*
   * A video. A poster has no caption to wait for — its words are on the
   * design — and greying the button on one left every poster with a dead Send
   * and a tooltip asking for something that was never coming. `canSend` is
   * the same question the server's `prepareSend` asks, so the button and the
   * send cannot disagree.
   */
  assert.ok(
    modal.includes("const canSend = isPoster || Boolean(caption.trim());"),
    "Send To Approval is dead until a video has its caption, and live for a poster"
  );
  assert.ok(
    modal.includes("disabled={pending || !canSend}"),
    "and the button reads that, not the caption box"
  );
  /*
   * And looks it. Left in its normal colour and merely refused on the press,
   * it reads as a broken button; greyed, it reads as a step that has not
   * happened yet, which is what it is.
   */
  assert.ok(
    modal.includes('buttonClasses(canSend ? {} : { variant: "secondary", className: "opacity-60" })'),
    "and goes grey rather than staying the colour of a ready action"
  );
  assert.ok(
    modal.includes('title={canSend ? undefined : "Generate or write the caption first"}'),
    "with the reason on hover, so a dead button is not a mystery"
  );

  // The rule is enforced on the server too — a greyed button is a courtesy,
  // not a guarantee, and every other way of sending goes through prepareSend.
  const wa = read("lib/whatsapp-approvals.ts");
  assert.ok(wa.includes("This video has no caption yet"), "and the send itself still refuses");
  ok("the client cannot be asked to approve a video that has no words yet");
}

await finish(pass);
