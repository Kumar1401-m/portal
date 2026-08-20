'use strict';

/**
 * What happens to a video on its way into a group. Run with:
 *
 *   node src/lib/media.test.js
 *
 * `fetch` is stubbed and no WhatsApp session is involved. The question is only
 * what the two halves decide — `video-file.js` about the bytes, and
 * `mediaFrom` about how they are sent — and every one of these decisions was a
 * real complaint from the group.
 *
 * The one that matters: a finished reel is routinely 100–300 MB, and WhatsApp
 * plays a video in a chat only up to about 16 MB. Every one of those used to
 * be replaced with a link, so the client was sent an address instead of the
 * thing they were being asked to approve.
 *
 * The re-encode itself needs ffmpeg, which is in the container and usually not
 * on a developer's machine — those checks say so and skip rather than fail, so
 * this file is still worth running either way.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { config } = require('../config');
const { WhatsAppService } = require('./whatsapp-client');
const videoFile = require('./video-file');

const svc = new WhatsAppService();
let passed = 0;
let failed = 0;
let skipped = 0;

const MB = 1024 * 1024;
const hasFfmpeg = spawnSync(config.ffmpeg.path, ['-version']).status === 0;

/** A fetch that answers with `bytes` of nothing, as a real web stream. */
const stub = (bytes, type, ok = true) => {
  global.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        const chunk = 64 * 1024;
        let left = bytes;
        while (left > 0) {
          const size = Math.min(chunk, left);
          controller.enqueue(new Uint8Array(size));
          left -= size;
        }
        controller.close();
      },
    });
    return {
      ok,
      status: ok ? 200 : 404,
      body,
      headers: {
        get: (h) =>
          h === 'content-length' ? String(bytes) : h === 'content-type' ? type : null,
      },
    };
  };
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

const skip = (label, why) => {
  skipped++;
  console.log(`  --  ${label}  (${why})`);
};

/** A real file of a given size, for the send-side decisions. */
function fileOf(bytes) {
  const p = path.join(os.tmpdir(), `wa-test-${Date.now()}-${Math.random()}.mp4`);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

(async () => {
  /* ---------------- getting the bytes ---------------- */

  await check('a small video is downloaded and left alone', async () => {
    stub(5 * MB, 'video/mp4');
    const ready = await videoFile.prepare('https://x/v.mp4');
    try {
      assert.strictEqual(ready.transcoded, false);
      assert.strictEqual(ready.bytes, 5 * MB);
      assert.ok(fs.existsSync(ready.file), 'it is on disk, not in memory');
    } finally {
      ready.cleanup();
    }
    assert.ok(!fs.existsSync(ready.file), 'and cleaned up afterwards');
  });

  await check('a Drive page that was never shared is refused, not sent', async () => {
    // 200 OK, and HTML: without this the client received a sign-in page as
    // their video, and nobody could say why it would not open.
    stub(4000, 'text/html; charset=utf-8');
    await assert.rejects(
      () => videoFile.prepare('https://drive.google.com/uc?id=x'),
      (e) => {
        assert.strictEqual(e.code, 'not_a_file');
        assert.strictEqual(e.permanent, true);
        assert.match(e.message, /shared publicly|upload the video/);
        return true;
      }
    );
  });

  await check('something enormous is refused before it is pulled', async () => {
    stub(config.send.maxSourceBytes + MB, 'video/mp4');
    await assert.rejects(
      () => videoFile.prepare('https://x/huge.mp4'),
      (e) => e.code === 'media_too_large' && e.permanent === true
    );
  });

  await check('a link that does not answer is a fetch failure, not a size one', async () => {
    stub(0, '', false);
    await assert.rejects(
      () => videoFile.prepare('https://x/v.mp4'),
      (e) => e.code === 'media_fetch_failed'
    );
  });

  /* ---------------- making it fit ---------------- */

  if (!hasFfmpeg) {
    skip('a 300 MB video is re-encoded until it fits', 'no ffmpeg on this machine');
    await check('without ffmpeg it degrades rather than failing', async () => {
      // The container has ffmpeg; a developer's machine usually does not. The
      // oversized file still comes back, to be sent as a document or a link.
      stub(30 * MB, 'video/mp4');
      const ready = await videoFile.prepare('https://x/big.mp4');
      try {
        assert.strictEqual(ready.bytes, 30 * MB);
        assert.strictEqual(ready.transcoded, false);
      } finally {
        ready.cleanup();
      }
    });
  } else {
    await check('a real video over the limit is re-encoded until it fits', async () => {
      // Two seconds of noise at a silly bitrate: small enough to make quickly,
      // big enough to have to be shrunk.
      const source = path.join(os.tmpdir(), `wa-test-src-${Date.now()}.mp4`);
      spawnSync(config.ffmpeg.path, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=2',
        '-c:v', 'libx264', '-b:v', '50M', source,
      ]);
      try {
        const target = 512 * 1024;
        const small = await videoFile.shrink(source, target);
        try {
          assert.ok(small.bytes <= target, `${small.bytes} bytes, over the ${target} asked for`);
          assert.ok(small.bytes > 1000, 'and it is a real file, not an empty one');
        } finally {
          videoFile.remove(small.out);
        }
      } finally {
        videoFile.remove(source);
      }
    });
  }

  /* ---------------- how it is sent ---------------- */

  await check('a small file plays in the chat', () => {
    const f = fileOf(2 * MB);
    try {
      const m = svc.mediaFrom({ file: f, bytes: 2 * MB, mimeType: 'video/mp4' }, 'a.mp4');
      assert.strictEqual(m.asDocument, false);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  await check('one WhatsApp will not play is sent as a file rather than a link', () => {
    const bytes = config.send.maxMediaBytes + MB;
    const f = fileOf(bytes);
    try {
      const m = svc.mediaFrom({ file: f, bytes, mimeType: 'video/mp4' }, 'a.mp4');
      assert.strictEqual(m.asDocument, true);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  await check('and past every ceiling, the link is the honest answer', () => {
    const bytes = config.send.maxDocumentBytes + MB;
    assert.throws(
      () => svc.mediaFrom({ file: '/nonexistent', bytes, mimeType: 'video/mp4' }, 'a.mp4'),
      (e) => e.code === 'media_too_large' && e.permanent === true
    );
  });

  /* ---------------- the question never overtakes the video ---------------- */

  await check('the follow-ups are sent by the service, after the media', () => {
    /*
     * They used to be sent by the portal once the send call returned. Fine
     * while every send took seconds, and wrong the moment a big file started
     * being re-encoded in the background: the client would be asked to approve
     * a video that had not arrived. Ordering inside a group is this service's
     * business, so they travel with the job.
     */
    const src = fs.readFileSync(path.join(__dirname, 'whatsapp-client.js'), 'utf8');
    const sendVideoAt = src.indexOf('async sendVideo(');
    const mediaAt = src.indexOf('sendMediaAsDocument', sendVideoAt);
    assert.ok(mediaAt > 0, 'the media message is in sendVideo');

    // Twice, deliberately: once after the media message, and once on the link
    // fallback — a client sent a link is still owed the question.
    const afterMedia = src.indexOf('this.sendFollowUps(groupId, followUps)', mediaAt);
    const onFallback = src.slice(sendVideoAt, mediaAt).includes('sendFollowUps(groupId, followUps)');
    assert.ok(afterMedia > mediaAt, 'they are sent after the media message');
    assert.ok(onFallback, 'and after the link, when the file could not be sent at all');

    const queue = fs.readFileSync(path.join(__dirname, 'send-queue.js'), 'utf8');
    assert.match(queue, /followUpsSent/, 'and says so, so the portal does not repeat them');
  });

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failed ? 1 : 0);
})();
