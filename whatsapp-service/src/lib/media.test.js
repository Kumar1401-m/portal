'use strict';

/**
 * What happens to a video on its way into a group. Run with:
 *
 *   node src/lib/media.test.js
 *
 * `fetch` is stubbed, so this touches no network and no WhatsApp session — the
 * question is only what `fetchMedia` decides about a set of bytes, and every
 * one of these decisions was a real complaint.
 *
 * The one that matters: a finished reel is usually bigger than the 16 MB
 * WhatsApp will play in a chat, and every one of those used to be replaced
 * with a link. Sent as a document the same file arrives and the client
 * downloads it, which is what was wanted.
 */
const assert = require('assert');
const { WhatsAppService } = require('./whatsapp-client');

const svc = new WhatsAppService();
let passed = 0;
let failed = 0;

const stub = (bytes, type, ok = true) => {
  global.fetch = async () => ({
    ok,
    status: ok ? 200 : 404,
    headers: {
      get: (h) =>
        h === 'content-length' ? String(bytes) : h === 'content-type' ? type : null,
    },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  });
};

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${label}\n       ${err.message}`);
  }
}

const MB = 1024 * 1024;

(async () => {
  await check('a small video plays in the chat', async () => {
    stub(5 * MB, 'video/mp4');
    const m = await svc.fetchMedia('https://x/v.mp4', 'a.mp4');
    assert.strictEqual(m.asDocument, false);
    assert.strictEqual(m.bytes, 5 * MB);
  });

  await check('a 30 MB reel is sent as a file rather than replaced by a link', async () => {
    stub(30 * MB, 'video/mp4');
    const m = await svc.fetchMedia('https://x/v.mp4', 'a.mp4');
    assert.strictEqual(m.asDocument, true);
  });

  await check('past both ceilings, the link is the honest answer', async () => {
    stub(120 * MB, 'video/mp4');
    await assert.rejects(
      () => svc.fetchMedia('https://x/v.mp4'),
      (e) => e.code === 'media_too_large' && e.permanent === true
    );
  });

  await check('a Drive page that was never shared is refused, not sent', async () => {
    // 200 OK, and HTML: without this the client received a sign-in page as
    // their video, and nobody could say why it would not open.
    stub(4000, 'text/html; charset=utf-8');
    await assert.rejects(
      () => svc.fetchMedia('https://drive.google.com/uc?id=x'),
      (e) => {
        assert.strictEqual(e.code, 'not_a_file');
        assert.strictEqual(e.permanent, true);
        assert.match(e.message, /shared publicly|upload the video/);
        return true;
      }
    );
  });

  await check('a link that does not answer is a fetch failure, not a size one', async () => {
    stub(0, '', false);
    await assert.rejects(
      () => svc.fetchMedia('https://x/v.mp4'),
      (e) => e.code === 'media_fetch_failed'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
