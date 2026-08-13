/**
 * A session waiting to be scanned is not a session that has failed.
 *
 * whatsapp-web.js drives a real Chromium, so closing it rejects whatever call
 * was in flight — "Target closed", "detached Frame", "Protocol error". Each is
 * the echo of a shutdown that already had a cause, and recording one as the
 * session's last error replaces the cause with its own echo.
 *
 * The damage was on the one screen that exists to say what to do next: a
 * session sitting healthily at "scan the QR" showed a Chromium protocol error
 * in red, so the page answered "what is wrong" over the top of "what to do",
 * with an answer nobody could act on.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const ROOT = `${SRC}/../..`;

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- teardown noise is not a session error ---------------- */
{
  const client = readFileSync(`${ROOT}/whatsapp-service/src/lib/whatsapp-client.js`, "utf8");

  has(client, "const TEARDOWN_NOISE =", "browser teardown errors are named");
  has(client, "noteError(message) {", "and one filter records every failure");

  // Every path that used to assign lastError directly now goes through it, so
  // a new one cannot be added that quietly bypasses the filter.
  for (const call of [
    "this.noteError(err.message)",
    "this.noteError(message)",
    "this.noteError(reason)",
  ]) {
    has(client, call, `${call} is filtered`);
  }
  assert.ok(
    !/this\.lastError = (err\.message|message|String\(reason\))/.test(client),
    "and nothing writes lastError around the filter"
  );

  // Dropped, never allowed to overwrite: a real reason already recorded must
  // survive the noise that follows it.
  has(client, "if (!text) return;", "an empty message records nothing");
  ok("the browser closing is not recorded as the session's problem");
}

/* ---------------- and a QR clears what came before it ---------------- */
{
  const client = readFileSync(`${ROOT}/whatsapp-service/src/lib/whatsapp-client.js`, "utf8");

  // A QR means Chromium is up and WhatsApp Web is asking to be logged in.
  // That is healthy and waiting on a person, not on a fix.
  const qrAt = client.indexOf("this.qrGeneratedAt = new Date()");
  const clearAt = client.indexOf("this.lastError = null", qrAt);
  assert.ok(qrAt > 0, "the QR handler is there");
  assert.ok(clearAt > qrAt, "and reaching it clears whatever came before");

  const panel = readFileSync(`${SRC}/app/(app)/settings/whatsapp/session-panel.tsx`, "utf8");
  has(
    panel,
    "snapshot.lastError && !isConnected && !qr",
    "and the panel does not print one over the scanning instructions"
  );
  ok("a session waiting to be scanned reports no fault");
}

/* ---------------- the log keeps its levels meaningful ---------------- */
{
  const index = readFileSync(`${ROOT}/whatsapp-service/src/index.js`, "utf8");
  has(index, "browser teardown rejection", "a teardown rejection is debug");
  has(index, "else log.error('unhandled rejection'", "and a real one is still an error");
  ok("expected noise does not train everyone to ignore ERROR");
}

await finish(pass);
