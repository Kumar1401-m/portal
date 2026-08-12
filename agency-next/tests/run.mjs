/**
 * Run every check in this folder.
 *
 *   npm test
 *
 * These lived in an OS temp directory until the cleaner deleted them twice,
 * taking fourteen files with it the second time. They are the only thing
 * standing between a refactor and a client being told the wrong posting time,
 * so they belong in the repository with the code they describe.
 *
 * Each file is a plain node script that exits non-zero on the first failed
 * assertion and prints "<n> checks passed" at the end. No framework: the whole
 * harness is `loader.mjs`, which lets node import the app's own .ts modules —
 * so a test exercises the real function rather than a copy of it.
 *
 * They talk to the local database and clean up after themselves. Every fixture
 * is prefixed "ZZ " so a half-finished run leaves something obviously
 * disposable rather than something that looks like a client.
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");

const only = process.argv.slice(2);
/** The harness itself, not checks. */
const HELPERS = new Set(["run.mjs", "loader.mjs", "finish.mjs"]);

const files = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && !HELPERS.has(f))
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)))
  .sort();

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--env-file=.env.local",
        "--import",
        `file:///${path.join(here, "loader.mjs").replace(/\\/g, "/")}`,
        path.join(here, file),
      ],
      {
        cwd: path.resolve(here, ".."),
        env: { ...process.env, PORTAL_SRC: src },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ file, code, out }));
  });

let passed = 0;
const failed = [];

for (const file of files) {
  const r = await run(file);
  const m = r.out.match(/^(\d+) checks passed/m);
  if (r.code === 0 && m) {
    passed += Number(m[1]);
    console.log(`  ${file.replace(".mjs", "").padEnd(16)} ${m[1]}`);
  } else {
    failed.push(file);
    console.log(`\n  ✗ ${file}`);
    // The assertion and its message, without node's module-loading noise.
    console.log(
      r.out
        .split("\n")
        .filter((l) => !/Warning|Reparsing|type.: .module|^\(node|^\s+at /.test(l))
        .slice(-14)
        .map((l) => `    ${l}`)
        .join("\n")
    );
  }
}

console.log(
  `\n${passed} checks passed across ${files.length - failed.length}/${files.length} files` +
    (failed.length ? `\nFAILED: ${failed.join(", ")}` : "")
);
process.exit(failed.length ? 1 : 0);
