/**
 * A client's agreed caption shape, actually being followed.
 *
 * The portal had every part of this except one. `clients.caption_template`
 * existed, `renderTemplateRule` turned it into a prompt block headed "THIS IS
 * NOT OPTIONAL", and the caption prompt carried a rule saying to reproduce it
 * exactly — but nothing in the whole application ever *wrote* that column.
 * There was no field for it on the client form and no other way in. So a
 * client with an agreed structure got captions in whatever shape the model
 * felt like, and the code read as though the feature worked.
 *
 * The other half was the hashtags. A structure almost always ends with the
 * client's own tag line, and the writer is told to put them there and nowhere
 * else — while the portal appended its own block underneath regardless. Two
 * tag blocks, one right under the other, which is the single part of a caption
 * shape a client is guaranteed to notice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);
const ctxLib = await import(pathToFileURL(`${SRC}/lib/client-context.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * There is somewhere to write it
 * ------------------------------------------------------------------ */
{
  const form = read("app/(app)/clients/client-form.tsx");
  assert.ok(form.includes('name="caption_template"'), "the client form has a field for it");
  assert.ok(form.includes("caption_template: string;"), "and carries it in the defaults");

  const edit = read("app/(app)/clients/[id]/edit/page.tsx");
  assert.ok(
    edit.includes("caption_template: str(client.caption_template),"),
    "editing a client shows the one already saved"
  );

  /*
   * And saving keeps it. Guarded on the column, like every other field that
   * arrived with a later migration — a database that has not run it must
   * still be able to save a client.
   */
  const actions = read("app/(app)/clients/actions.ts");
  assert.ok(
    actions.includes('if (await hasColumn("clients", "caption_template")) {'),
    "saving is guarded on the column existing"
  );
  assert.ok(
    actions.includes('columns.caption_template = orNull(s(fd, "caption_template"));'),
    "and writes what was typed"
  );
  ok("a caption structure can be written down, saved, and edited again");
}

/* ------------------------------------------------------------------ *
 * And it reaches the model as an instruction, not a suggestion
 * ------------------------------------------------------------------ */
{
  const rule = ctxLib.renderTemplateRule({
    captionTemplate: "✨ {{location}} special\n\n[what happens]\n\n📞 {{whatsapp}}\n\n#shop #{{location}}",
    placeholders: { location: "Hyderabad" },
  });

  assert.ok(rule, "a client with a template gets a rule");
  assert.ok(rule.includes("THIS IS NOT OPTIONAL"), "phrased as a requirement");
  assert.ok(rule.includes("Hyderabad special"), "with the placeholders it can already fill filled in");
  assert.ok(!rule.includes("{{location}}"), "and none of those left as braces");
  /*
   * An unfilled placeholder is named rather than dropped, because the caption
   * must never go out with "{{whatsapp}}" in it — a client reading their own
   * caption back is the worst possible place to find a templating artefact.
   */
  assert.ok(rule.includes("{{whatsapp}}"), "one it cannot fill is handed to the model to fill");
  assert.ok(rule.includes("Never leave the braces in the caption"), "and never left as-is");

  assert.equal(
    ctxLib.renderTemplateRule({ captionTemplate: null, placeholders: {} }),
    null,
    "a client with no structure gets no rule at all"
  );

  const ai = read("lib/video-ai.ts");
  assert.ok(ai.includes("templateRule: ctx ? renderTemplateRule(ctx) : null,"), "the caption brief carries it");
  assert.ok(
    ai.includes("FOLLOW THE TEMPLATE ABOVE EXACTLY"),
    "and the rules under the JSON contract repeat it, where instructions are obeyed"
  );
  ok("the structure reaches the writer as a requirement it cannot read past");
}

/* ------------------------------------------------------------------ *
 * Nothing is stapled underneath it
 * ------------------------------------------------------------------ */
{
  const tags = "#agency #hyderabad #reels";

  // The shape a template gives: the client's own tag line is the last thing.
  const templated = "✨ Gold rate down\n\nCome and see.\n\n📞 90000 00000\n\n#zzjewellers #hyderabad";
  assert.equal(
    ig.composeCaption(templated, tags),
    templated,
    "a caption that already ends in its own tag block is left exactly as written"
  );

  // No tags of its own: ours still go on, as they always did.
  const plain = "✨ Gold rate down\n\nCome and see.";
  assert.equal(
    ig.composeCaption(plain, tags),
    `${plain}\n\n${tags}`,
    "a caption with no tags still gets the block it was expecting"
  );

  /*
   * One tag at the end of a sentence is not a tag block. Treating it as one
   * would silently drop the hashtags from every ordinary caption that happens
   * to mention a #thing last.
   */
  const oneTag = "Come and see us at #zzjewellers";
  assert.equal(
    ig.composeCaption(oneTag, tags),
    `${oneTag}\n\n${tags}`,
    "a single trailing tag is a word, not a block"
  );

  // The older duplicate-suppression still holds.
  assert.equal(
    ig.composeCaption(`${plain}\n\n${tags}`, tags),
    `${plain}\n\n${tags}`,
    "and the same tags are never published twice"
  );
  assert.equal(ig.composeCaption(plain, null), plain, "no tags, no join");
  assert.equal(ig.composeCaption(null, tags), tags, "no caption, just the tags");
  ok("the client's tag line is the end of the caption, not the middle of it");
}

await finish(pass);
