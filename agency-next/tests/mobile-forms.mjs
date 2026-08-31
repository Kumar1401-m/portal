/**
 * Typing on a phone.
 *
 * iOS Safari zooms the whole page whenever a focused input's computed font is
 * smaller than 16px. Every field in this portal was `text-sm`, which is 14 —
 * so tapping Email on an iPhone zoomed in, shifted the layout out from under
 * the thumb, and left the person pinching back out before they could type a
 * character. On the sign-in screen that is the first thing anybody sees, and
 * it reads as the site being broken rather than as a browser behaviour.
 *
 * It is one line in three shared components, and it was every form in the
 * portal — the client's too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

/*
 * Comments stripped before matching. These files explain *why* the old values
 * were wrong, and a test that failed on the explanation would push somebody to
 * delete the reasoning to get green — which is how the next person puts the
 * bug straight back.
 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * 16px on a phone, 14 from `sm` up
 * ------------------------------------------------------------------ */
{
  for (const f of ["components/ui/input.tsx", "components/ui/select.tsx", "components/ui/textarea.tsx"]) {
    const s = read(f);
    assert.ok(
      s.includes("text-base sm:text-sm"),
      `${f} is 16px on a phone, so focusing it does not zoom the page`
    );
    /*
     * And nothing left at a bare `text-sm` in the base classes. The desktop
     * size is the *override*, so writing it the other way round — `text-sm
     * sm:text-base` — would be the bug back again with the words rearranged.
     */
    assert.ok(
      !/py-2 text-sm/.test(s),
      `${f} has no bare text-sm left in its base classes`
    );
  }
  ok("every shared field is 16px on a phone and unchanged on a desktop");
}

/* ------------------------------------------------------------------ *
 * The screen fits the phone it is on
 * ------------------------------------------------------------------ */
{
  const login = strip(read("app/(auth)/login/page.tsx"));

  /*
   * `100vh` on a phone is the viewport with the browser's toolbars *hidden*,
   * so a screen sized to it has its bottom tucked behind the URL bar until you
   * scroll. On a centred sign-in card that puts the Sign in button under the
   * chrome, on the one screen nobody has learnt their way around yet.
   */
  assert.ok(login.includes("min-h-dvh"), "the sign-in screen is sized to the visible viewport");
  assert.ok(!login.includes("min-h-screen"), "and not to the one with the toolbars hidden");
  assert.ok(strip(read("app/portal/layout.tsx")).includes("min-h-dvh"), "and so is the client portal");

  // Room to type on a 320px phone: 24px of page padding each side plus a 32px
  // card inset leaves about 208px of field.
  assert.ok(login.includes("px-4 py-8"), "less page padding on a small screen");
  assert.ok(login.includes("sm:px-6 sm:py-12"), "and the roomier version from sm up");
  assert.ok(login.includes("p-6 shadow-2xl backdrop-blur-sm sm:p-8"), "same for the card itself");
  ok("the sign-in card fits a phone without pinching or scrolling");
}

/* ------------------------------------------------------------------ *
 * Pinch zoom is left alone
 * ------------------------------------------------------------------ */
{
  /*
   * The other way to stop iOS zooming on focus is `maximum-scale=1`, and it is
   * the wrong way: it also takes pinch-zoom away from everybody, including the
   * people who need it to read. Sizing the text is the fix that costs nobody
   * anything.
   */
  for (const f of ["app/layout.tsx", "app/(auth)/login/page.tsx", "app/portal/layout.tsx"]) {
    const s = strip(read(f));
    assert.ok(!/maximum-scale/.test(s), `${f} does not disable zoom`);
    assert.ok(!/user-scalable\s*=\s*no/.test(s), `${f} does not lock the scale`);
  }
  ok("nobody's pinch zoom was taken away to fix this");
}

await finish(pass);
