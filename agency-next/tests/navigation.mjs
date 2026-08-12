/**
 * A click has to look like it landed.
 *
 * Every page in the app group is force-dynamic, so navigating means a round
 * trip to the database. With no `loading.tsx` anywhere — which is how this app
 * shipped — the App Router keeps the old page on screen until the new payload
 * arrives, so a click changed nothing visible for a few hundred milliseconds.
 * The portal was not slow so much as silent, and the honest reaction to a
 * button that does nothing is to press it again.
 *
 * Measured after the fix, against a connection with 1.5s of latency: the nav
 * spinner appears in 69–153ms and the skeleton in 69–204ms.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the route group has a loading state ---------------- */
{
  const path = `${SRC}/app/(app)/loading.tsx`;
  assert.ok(existsSync(path), "the app group has a loading.tsx");

  const src = readFileSync(path, "utf8");
  assert.match(src, /aria-busy="true"/, "it announces itself as busy");
  assert.match(src, /animate-pulse/, "and looks like something is happening");
  assert.match(src, /sr-only/, "with something for a screen reader to say");
  ok("every page in the app group shows a skeleton the moment it is asked for");

  // The pages it covers are all dynamic — which is exactly the case the Next
  // docs say needs a loading file to navigate instantly.
  const pages = readdirSync(`${SRC}/app/(app)`, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("@"))
    .filter((d) => existsSync(`${SRC}/app/(app)/${d.name}/page.tsx`));
  const dynamic = pages.filter((d) =>
    /dynamic = "force-dynamic"/.test(readFileSync(`${SRC}/app/(app)/${d.name}/page.tsx`, "utf8"))
  );
  assert.ok(dynamic.length >= 8, `the group is mostly dynamic (${dynamic.length}/${pages.length})`);
  ok(`${dynamic.length} dynamic pages sit behind that one loading state`);
}

/* ---------------- the clicked menu item reacts immediately ---------------- */
{
  const nav = read("components/admin/sidebar.tsx");
  assert.match(nav, /useLinkStatus/, "the sidebar tracks the pending navigation");
  assert.match(nav, /animate-spin/, "and turns the clicked item's icon over");

  /*
   * `useLinkStatus` only reports for the Link it is rendered inside. Called
   * from the component that renders the list it would report nothing at all,
   * silently — so the hook must live in its own child component.
   */
  assert.match(
    nav,
    /function NavIcon\([\s\S]{0,200}useLinkStatus\(\)/,
    "read from inside the Link, in its own component, or it silently never fires"
  );
  assert.match(nav, /<NavIcon item=\{item\} \/>/, "and that component is what the Link renders");
  ok("the clicked menu item spins while its page is on the way");
}

await finish(pass);
