/**
 * How a test ends.
 *
 * Every one of these opens a MySQL pool, which keeps the event loop alive, so
 * they all used a bare `process.exit(0)`. That is fine until a test also makes
 * an outbound request — the assistant one calls the model — and then exiting
 * on top of a socket mid-close trips a libuv assertion on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * Which reports a passing file as a failure, for no reason a reader could
 * guess. Closing the pool first lets node leave on its own; the timeout is
 * there so a genuinely stuck handle still ends the run rather than hanging a
 * suite forever.
 */
import { pathToFileURL } from "node:url";

export async function finish(passed) {
  console.log(`\n${passed} checks passed`);
  try {
    const db = await import(pathToFileURL(`${process.env.PORTAL_SRC}/lib/db.ts`).href);
    await db.getPool().end();
  } catch {
    /* nothing to close */
  }
  // Unref'd: it never keeps the process alive, it only catches one that will
  // not leave.
  setTimeout(() => process.exit(0), 2000).unref();
}
