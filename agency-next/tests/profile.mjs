/**
 * A staff member's own profile picture.
 *
 * Clients have had one since the portal began; everybody else was two letters
 * in a circle. The upload reuses the client flow — signed PUT straight to R2,
 * only the key stored — so the part worth testing is not the upload but the
 * one line that decides whether a key belongs to the person saving it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const storage = await load("lib/storage.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- staff keys and client keys are separate namespaces ---------------- */
{
  const key = storage.buildStaffAvatarKey(7, "me.PNG");
  assert.match(key, /^avatars\/staff\/7\/\d+\.png$/, "a staff key is namespaced and lower-cased");

  // The collision this prevents: user ids and client ids are independent
  // sequences, so user 7 and client 7 both exist. Without the "staff" segment
  // they would generate keys each other's save action would accept.
  const clientKey = storage.buildAvatarKey(7, "logo.jpg");
  assert.match(clientKey, /^avatars\/7\/\d+\.jpg$/);
  assert.ok(!clientKey.startsWith("avatars/staff/"), "and a client key is not under it");

  // An unknown extension becomes jpg rather than being trusted into the key.
  assert.match(storage.buildStaffAvatarKey(3, "x.svg?a=1"), /\.jpg$/, "a odd extension falls back");
  assert.match(storage.buildStaffAvatarKey(3, "noext"), /\.jpg$/, "and so does none at all");
  ok("a staff picture cannot be written where a client's would go");
}

/* ---------------- and the save accepts only its own ---------------- */
{
  /*
   * The real check, lifted from the action: a literal prefix and a literal
   * regex. It was briefly a pattern built from a template — `\d` in the
   * source, `\d` in the string — and getting that wrong fails in the safe
   * direction, refusing every genuine upload as "not yours", which reads as a
   * broken uploader rather than a broken check. Hence a test.
   */
  const accepts = (userId, key) => {
    const prefix = `avatars/staff/${userId}/`;
    return key.startsWith(prefix) && /^\d+\.[a-z0-9]{1,5}$/.test(key.slice(prefix.length));
  };

  assert.equal(accepts(7, "avatars/staff/7/1755500000000.jpg"), true, "its own upload");
  assert.equal(accepts(7, "avatars/staff/8/1755500000000.jpg"), false, "not someone else's");
  assert.equal(accepts(7, "avatars/7/1755500000000.jpg"), false, "not a client's");
  assert.equal(accepts(7, "videos/9/final.mp4"), false, "not a video");
  assert.equal(accepts(7, "avatars/staff/7/../../secret.jpg"), false, "no traversal");
  assert.equal(accepts(7, "avatars/staff/7/a/b.jpg"), false, "and nothing nested");
  assert.equal(accepts(7, "avatars/staff/7/123"), false, "an extension is required");
  assert.equal(accepts(7, "avatars/staff/70/1.jpg"), false, "7 does not match 70");

  // And the source really does use the literal form the check above mirrors.
  const src = read("app/(app)/profile/actions.ts");
  assert.match(src, /const prefix = `avatars\/staff\/\$\{user\.id\}\/`;/, "prefix is a literal");
  // Checked as a substring, not as a regex describing a regex — that nesting
  // is the same escaping trap this whole block exists because of.
  assert.ok(
    src.includes(String.raw`/^\d+\.[a-z0-9]{1,5}$/.test(key.slice(prefix.length))`),
    "and the pattern is a regex literal, so there is no escaping layer to get wrong"
  );
  assert.ok(!src.includes("new RegExp("), "nothing here builds a pattern from a string");
  ok("the save accepts a key it issued to this user, and nothing else");
}

/* ---------------- everyone on the team, and only for themselves ---------------- */
{
  const src = read("app/(app)/profile/actions.ts");
  // Not ADMIN_ROLES: an editor's face is the one that appears beside their
  // work on other people's boards.
  assert.match(src, /requireUser\(STAFF_ROLES\)/, "every staff role may set one");
  assert.equal(
    (src.match(/requireUser\(STAFF_ROLES\)/g) || []).length,
    3,
    "on all three actions — presign, save and remove"
  );
  // There is deliberately no "set someone else's" path, super admin included:
  // it would be a way to put a face on another person's actions.
  assert.ok(!/userId|targetUser|params\.id/.test(src), "and only ever for yourself");
  assert.match(src, /WHERE id = \?", \[user\.id\]/, "scoped to the caller's own row");

  const page = read("app/(app)/profile/page.tsx");
  assert.match(page, /requireUser\(STAFF_ROLES\)/, "the page is open to the whole team");
  // Name, email and role decide what someone may reach, so they are not
  // editable from the page the person themselves opens.
  assert.ok(!/<input[^>]*name="email"/.test(page), "and it cannot change who you are");
  ok("every staff role can set their own picture, and nobody else's");
}

/* ---------------- it shows, and it degrades ---------------- */
{
  const bar = read("components/admin/topbar.tsx");
  assert.match(bar, /avatarUrl \? \(/, "the top bar shows the picture");
  assert.match(bar, /initials\(user\.name\)/, "and falls back to initials");
  assert.match(bar, /href="\/profile"/, "with a way to reach the page");

  // The column is new. A database that has not applied it must render the
  // shell every page lives inside, not fail it.
  const layout = read("app/(app)/layout.tsx");
  assert.match(layout, /hasColumn\("users", "avatar_url"\)/, "gated on the column existing");
  assert.match(layout, /return null;/, "and shows initials until it does");

  const actions = read("app/(app)/profile/actions.ts");
  assert.match(actions, /Settings → Database/, "the save says what is missing, in words");
  ok("the picture appears in the top bar, and its absence changes nothing");
}

await finish(pass);
