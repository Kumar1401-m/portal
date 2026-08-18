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

/* ---------------- the drawers, and who gets one ---------------- */
{
  const nav = await import(
    (await import("node:url")).pathToFileURL(`${SRC}/components/admin/nav-config.ts`).href
  );

  const sections = nav.navSectionsForRole("super_admin");
  const groups = sections.filter((s) => s.kind === "group");
  assert.deepEqual(
    groups.map((g) => g.key),
    ["production", "clients", "money", "growth"],
    "four drawers, in the order the work happens"
  );

  // Every item lands somewhere. A module that appears in no section is a
  // module nobody can reach, and the nav is the honest list of what exists.
  const placed = sections.flatMap((s) => (s.kind === "item" ? [s.item.href] : s.items.map((i) => i.href)));
  const expected = nav.navForRole("super_admin").map((n) => n.href);
  assert.deepEqual([...placed].sort(), [...expected].sort(), "nothing is lost in the regrouping");
  assert.equal(new Set(placed).size, placed.length, "and nothing appears twice");

  // Dashboard first, Settings last — the two you reach without thinking.
  assert.equal(sections[0].item?.href, "/dashboard");
  assert.equal(sections[sections.length - 1].item?.href, "/settings");

  ok("every module sits in exactly one of four drawers, or beside them");
}

/* ---------------- a drawer holding one thing is not a drawer ---------------- */
{
  const nav = await import(
    (await import("node:url")).pathToFileURL(`${SRC}/components/admin/nav-config.ts`).href
  );

  // A poster designer sees Today's Tasks and My work. A "Production" heading
  // to click before reaching the single item under it would be a worse nav
  // than the flat one this replaced.
  for (const role of ["poster_designer", "video_editor", "crm", "admin", "super_admin"]) {
    for (const s of nav.navSectionsForRole(role)) {
      if (s.kind === "group") {
        assert.ok(s.items.length >= 2, `${role}: the ${s.key} drawer holds more than one thing`);
      }
    }
  }

  const designer = nav.navSectionsForRole("poster_designer");
  assert.ok(
    designer.every((s) => s.kind === "item"),
    "a poster designer gets plain links, no drawers at all"
  );
  // And an editor, who sees the least of anyone, still reaches their work.
  assert.ok(nav.navSectionsForRole("video_editor").some((s) => s.item?.href === "/my-work"));
  ok("roles that see little get plain links rather than drawers with one item in");
}

/* ---------------- arriving anywhere opens the right drawer ---------------- */
{
  const nav = await import(
    (await import("node:url")).pathToFileURL(`${SRC}/components/admin/nav-config.ts`).href
  );

  assert.equal(nav.groupForPath("super_admin", "/analytics"), "growth");
  assert.equal(nav.groupForPath("super_admin", "/payments"), "money");
  assert.equal(nav.groupForPath("super_admin", "/deliverables"), "production");
  // A deeper path, which is how most arrivals happen — a pasted task link.
  assert.equal(nav.groupForPath("super_admin", "/clients/12/studio"), "clients");
  assert.equal(nav.groupForPath("super_admin", "/deliverables/391"), "production");
  // Outside every drawer, and a route that is not in the nav at all.
  assert.equal(nav.groupForPath("super_admin", "/dashboard"), null);
  assert.equal(nav.groupForPath("super_admin", "/nowhere"), null);
  // Scoped: a crm has no Automations, so its path opens nothing for them.
  assert.equal(nav.groupForPath("crm", "/automations"), null);

  const src = read("components/admin/sidebar.tsx");
  assert.match(src, /useState<Set<GroupKey>>\(\(\) => new Set\(here \? \[here\] : \[\]\)\)/,
    "the drawer for the current page starts open");
  assert.match(src, /holdsCurrent && !expanded/, "and a closed drawer still says the page is inside it");
  ok("the drawer holding the current page opens by itself, even from a pasted link");
}

/* ---------------- "My work" is a maker's dashboard, unless they have one ---------------- */
{
  const nav = await import(
    (await import("node:url")).pathToFileURL(`${SRC}/components/admin/nav-config.ts`).href
  );

  const labelOf = (role, href) => {
    for (const s of nav.navSectionsForRole(role)) {
      if (s.kind === "item" && s.item.href === href) return s.item.label;
      if (s.kind === "group") {
        const hit = s.items.find((i) => i.href === href);
        if (hit) return hit.label;
      }
    }
    return null;
  };

  // For a designer or an editor this IS their dashboard — where they land,
  // their counts, and the box they submit from.
  assert.equal(labelOf("poster_designer", "/my-work"), "Dashboard");
  assert.equal(labelOf("video_editor", "/my-work"), "Dashboard");
  assert.equal(labelOf("poster_designer", "/dashboard"), null, "and they have no other one");

  // An admin has both, so it keeps its own name — two links called
  // "Dashboard" in one nav would be worse than the name it started with.
  assert.equal(labelOf("admin", "/dashboard"), "Dashboard");
  assert.equal(labelOf("admin", "/my-work"), "My work");
  ok("a maker's landing page is called Dashboard, without colliding on an admin's nav");
}

/* ---------------- the studio is production work ---------------- */
{
  const nav = await import(
    (await import("node:url")).pathToFileURL(`${SRC}/components/admin/nav-config.ts`).href
  );
  assert.equal(nav.groupForPath("super_admin", "/studio"), "production",
    "writing the month's content sits with the rest of production");
  // Reachable from the nav as well as from a client's own page.
  assert.ok(nav.navForRole("crm").some((n) => n.href === "/studio"), "a crm can open it too");
  assert.ok(!nav.navForRole("video_editor").some((n) => n.href === "/studio"), "an editor cannot");
  ok("the content studio is in Production and reachable without going through a client");
}

await finish(pass);
