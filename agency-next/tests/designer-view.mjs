/**
 * What a poster designer is shown, and what they are spared.
 *
 * A designer has three screens and they had grown into three copies of each
 * other: My work counted their posters, the Posters page counted them again,
 * and both listed the same rows — only one of which had the box to submit a
 * design. Every removal here is a duplicate, not a capability.
 *
 * Each is scoped to the designer. A super admin's Posters page spans every
 * client and its totals appear nowhere else; an editor's My work is their
 * whole portal and its worklist is the only one they have.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the Posters page is a worklist, not a dashboard ---------------- */
{
  const src = read("app/(app)/poster/page.tsx");
  assert.match(
    src,
    /const counts = isDesigner\s*\n?\s*\? null/,
    "a designer gets no stat cards — My work already counts their posters"
  );
  assert.match(src, /\{counts \? \(/, "and the block only renders when there are counts");
  assert.match(src, /StatCard title="To design"/, "which a super admin still gets");
  ok("the Posters page drops its dashboard for the designer, keeps it for the super admin");
}

/* ---------------- no worklist twice ---------------- */
{
  const src = read("app/(app)/my-work/page.tsx");
  assert.match(
    src,
    /\{!isDesigner && work\.upNext\.length > 0 \? \(/,
    "Up next is skipped for a designer — the Posters page is the same list, with a Submit box"
  );
  // An editor has no Posters page. My work is their whole portal.
  assert.match(src, /work\.upNext\.map/, "and the list still exists for everyone else");
  ok("Up next goes for the designer only; an editor's only worklist stays");
}

/* ---------------- columns that could never hold anything ---------------- */
{
  const src = read("app/(app)/today/page.tsx");

  // Raw footage and the cut video belong to the video track. On a designer's
  // board both were a dash on every row.
  assert.match(
    src,
    /\{isDesigner \? null : \(\s*\n\s*<>\s*\n\s*<th className="hidden text-center xl:table-cell">Shoot<\/th>\s*\n\s*<th className="hidden text-center xl:table-cell">Video<\/th>/,
    "the two headers are hidden for a designer"
  );
  assert.match(
    src,
    /\{isDesigner \? null : \(\s*\n\s*<>\s*\n\s*<TD className="hidden whitespace-nowrap text-center xl:table-cell">\s*\n\s*\{d\.raw_drive_link/,
    "and so are the two cells"
  );

  /*
   * Header and cell must be gated by the same condition, or the table shears —
   * ten headings over twelve cells puts every value under the wrong name,
   * which is worse than a column of dashes. Verified in a browser too:
   * designer 10 cols / 10 cells, super admin 12 / 12.
   */
  const gates = (src.match(/\{isDesigner \? null : \(/g) || []).length;
  assert.equal(gates, 2, `exactly two gates — headers and cells (found ${gates})`);
  ok("Shoot and Video go together, header and cell, so the table cannot shear");
}

/* ---------------- the uploader follows the task, not its own name ---------------- */
{
  const up = read("app/(app)/deliverables/video-upload.tsx");
  assert.match(up, /isPoster \? "Upload Poster" : "Upload Video"/, "the button says what it takes");
  // The label was the least of it: the picker was filtered to video/* and the
  // check refused anything else, so a designer's PNG could not be attached at
  // all — and the reason given was that it did not look like a video.
  assert.match(up, /accept=\{isPoster \? "image\/\*" : "video\/\*"\}/, "the picker offers images");
  assert.match(up, /const wanted = isPoster \? "image\/" : "video\/"/, "and the check accepts them");
  assert.match(up, /isPoster \? "an image" : "a video"/, "and says which was expected");

  const modal = read("app/(app)/deliverables/edit-video-modal.tsx");
  assert.match(modal, /isPoster=\{isPoster\}/, "the edit modal passes what kind of task it is");
  assert.match(modal, /\{isPoster \? "Finished poster" : "Finished video"\}/, "and labels it to match");
  ok("a poster task asks for a poster, and will actually accept one");
}

await finish(pass);
