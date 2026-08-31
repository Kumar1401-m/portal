/**
 * A finished video refused for a reason nobody could act on.
 *
 * R2 answers a perfectly good PUT with `500 InternalError` now and then, and
 * Cloudflare documents it as retriable. The uploader did neither thing you
 * would want: it gave up on the first one, and it told the editor
 *
 *   Cloudflare returned 500 (InternalError). CORS is fine; this is a
 *   credentials problem.
 *
 * Both halves of that are wrong. A 5xx means the request reached R2 and R2
 * broke — the credentials had just worked, twice, to sign and to preflight —
 * so it sent somebody to Settings to fix keys that were not broken, after
 * throwing away an upload that would have worked on the next try.
 *
 * The three cases have to stay apart, because they look identical from the
 * outside and have nothing in common underneath:
 *
 *   status 0    the browser blocked it before it left        → CORS
 *   status 5xx  it arrived and Cloudflare failed             → wait, retry
 *   status 4xx  it arrived and Cloudflare refused            → credentials
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const src = readFileSync(`${SRC}/app/(app)/deliverables/video-upload.tsx`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- a 5xx is tried again before it is anyone's problem --------------- */
{
  assert.ok(
    src.includes("const BACKOFF_MS = [1000, 3000];"),
    "there is a backoff, and it is short enough that nobody walks away"
  );
  /*
   * The loop's own condition, not merely the number 500 somewhere in the file.
   * Asserting the latter passed with the loop bounded to zero iterations —
   * because the 5xx *message* further down mentions it too, and a test that
   * cannot tell the fix from the sentence describing it is not a test.
   */
  assert.ok(
    src.includes("for (let i = 0; i < BACKOFF_MS.length && result.status >= 500; i++)"),
    "the loop runs while Cloudflare is failing, and only then"
  );
  assert.ok(
    !/for\s*\([^)]*result\.status\s*(!==|<|>=)\s*(200|300|400)\b/.test(src),
    "never on a refusal, which would simply be refused again"
  );
  ok("a 500 from R2 is retried, not reported");
}

/* ---------------- the whole file goes again, from nought --------------- */
{
  /*
   * A single-part PUT has no resume, so a retry is the file again — and the
   * bar has to go back to nought with it or it sits at 90% through a second
   * upload and finishes at what looks like 180%.
   */
  assert.ok(
    src.includes("setProgress(0);\n      result = await attempt(signed.uploadUrl);"),
    "the progress bar restarts with the upload it is measuring"
  );
  ok("the second attempt is measured as its own");
}

/* ---------------- and it says so while it is happening --------------- */
{
  assert.match(
    src,
    /Cloudflare had a problem at its end — trying again/,
    "the reset bar is explained rather than left to look like a fault"
  );
  assert.ok(
    src.includes('phase === "uploading" ? "text-muted-foreground" : "text-destructive"'),
    "and a retry in progress is not painted as a failure"
  );
  ok("a retry reads as a retry");
}

/* ---------------- the three faults keep their own words --------------- */
{
  const branch = src.slice(src.indexOf("if (result.status === 0)"));

  assert.match(
    branch.slice(0, branch.indexOf("} else if")),
    /CORS policy/,
    "status 0 is still the CORS answer"
  );

  const fivexx = branch.slice(branch.indexOf("} else if"), branch.indexOf("} else {"));
  assert.match(fivexx, /result\.status >= 500/, "5xx has its own branch");
  assert.match(fivexx, /Nothing here is set up wrong/, "and says the setup is fine");
  assert.ok(
    !/credentials/i.test(fivexx),
    "a Cloudflare outage is never described as a credentials problem"
  );

  const fourxx = branch.slice(branch.indexOf("} else {"));
  assert.match(fourxx, /SignatureDoesNotMatch/, "and a real refusal still names the likely cause");
  assert.match(fourxx, /credentials problem/, "which is where that sentence belongs");
  ok("each fault is told apart from the other two");
}

await finish(pass);
