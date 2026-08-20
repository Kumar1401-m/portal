'use strict';

/**
 * Getting a big video small enough to send, without holding it in memory.
 *
 * A finished reel is routinely 100–300 MB, and WhatsApp plays a video inline
 * only up to about 16 MB. Everything above that used to be replaced with a
 * link — the client got an address instead of the thing they were asked to
 * approve, which is the one job the message has.
 *
 * So a file that is too big is re-encoded until it fits and then sent as a
 * video. Two things about how, both forced by the box this runs on: 2 GB of
 * memory shared with Chromium and the WhatsApp session, on one CPU.
 *
 *   Nothing is buffered. The download streams to a temp file and ffmpeg reads
 *   that file — a 300 MB `arrayBuffer()` plus its base64 copy is 700 MB of
 *   spike on a box that does not have it, and the kernel would pick the
 *   victim rather than us.
 *
 *   One at a time. ffmpeg will use every core it is given, and the WhatsApp
 *   session shares them.
 *
 * The target is a size, not a quality: the bitrate is worked out from the
 * video's own duration so the output lands under the limit whatever went in.
 * That means a long video comes out softer, which is the right trade — a
 * slightly soft video the client can watch beats a link they have to open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('video');

/** One transcode at a time — see the note above about the box. */
let chain = Promise.resolve();

const tmp = (suffix) =>
  path.join(os.tmpdir(), `wa-${Date.now()}-${Math.round(Math.random() * 1e9)}${suffix}`);

/** Delete a temp file, never throwing — this runs in `finally` blocks. */
function remove(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the next container start begins with an empty /tmp anyway */
  }
}

/**
 * Download to a temp file, streaming.
 *
 * Returns the path and what actually arrived. `content-length` is checked
 * first where the server offers it, so an enormous file is refused before it
 * is pulled rather than after — and the stream is counted as it goes, because
 * a server that lies about the length would otherwise fill the disk.
 */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Could not fetch the video (HTTP ${res.status})`);
    err.code = 'media_fetch_failed';
    throw err;
  }

  const type = (res.headers.get('content-type') || '').toLowerCase();
  /*
   * A page, not a file. A Google Drive link that was never shared publicly
   * answers 200 with a sign-in page, and without this that page was sent to
   * the client as their video.
   */
  if (type.startsWith('text/html')) {
    const err = new Error(
      'That link returns a web page rather than a file — check it is shared publicly, or upload the video to the portal instead.'
    );
    err.code = 'not_a_file';
    err.permanent = true;
    throw err;
  }

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > config.send.maxSourceBytes) {
    const err = new Error(
      `The file is ${(declared / 1048576).toFixed(0)} MB; this service will not download more than ` +
        `${(config.send.maxSourceBytes / 1048576).toFixed(0)} MB`
    );
    err.code = 'media_too_large';
    err.permanent = true;
    throw err;
  }

  const file = tmp('.src');
  let bytes = 0;
  try {
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      bytes += chunk.length;
      // A server that under-reports its length must not be able to fill the
      // disk: the stream is destroyed the moment it passes the ceiling.
      if (bytes > config.send.maxSourceBytes) body.destroy(new Error('over the download ceiling'));
    });
    await pipeline(body, fs.createWriteStream(file));
  } catch (err) {
    remove(file);
    if (/over the download ceiling/.test(err.message)) {
      const e = new Error(
        `The file is larger than the ${(config.send.maxSourceBytes / 1048576).toFixed(0)} MB this service will download`
      );
      e.code = 'media_too_large';
      e.permanent = true;
      throw e;
    }
    const e = new Error(`The download failed: ${err.message}`);
    e.code = 'media_fetch_failed';
    throw e;
  }

  log.info('downloaded', { bytes, mb: (bytes / 1048576).toFixed(1) });
  return { file, bytes, mimeType: type || 'video/mp4' };
}

/** Run a command, resolving with its stdout. Rejects on a non-zero exit. */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} took longer than ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    // ffmpeg writes progress to stderr; only the tail is kept, for the log.
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be started: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}: ${err.split('\n').slice(-3).join(' ').trim()}`));
    });
  });
}

/** Seconds of video, or 0 when the file will not admit to a duration. */
async function durationOf(file) {
  try {
    const out = await run(
      config.ffmpeg.probePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      30_000
    );
    const seconds = Number(String(out).split(/\s+/)[0]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch (err) {
    log.warn('could not read the duration', { error: err.message });
    return 0;
  }
}

/**
 * Re-encode until it fits.
 *
 * The bitrate is derived from the duration and the size we are aiming at, so
 * the output lands under the limit whatever the input was — a fixed quality
 * setting cannot promise that, and "it usually comes out small enough" is not
 * a promise you can make to a client's group.
 *
 * A second, harder pass runs if the first misses, which happens on footage
 * the encoder cannot compress as far as asked. After that it gives up and
 * lets the caller fall back.
 */
async function shrink(source, targetBytes) {
  const seconds = await durationOf(source);
  if (!seconds) {
    const err = new Error('That file does not look like a video we can re-encode.');
    err.code = 'not_a_video';
    err.permanent = true;
    throw err;
  }

  const attempt = async (fraction) => {
    // 90% of the target for the container overhead and the encoder's own
    // slack; audio is fixed and comes off the top.
    const audioKbps = 96;
    const totalKbps = Math.floor((targetBytes * fraction * 8) / seconds / 1000);
    const videoKbps = Math.max(200, totalKbps - audioKbps);
    const out = tmp('.mp4');

    await run(
      config.ffmpeg.path,
      [
        '-y',
        '-i', source,
        // Down to 1080 on the long edge at most, keeping the aspect ratio and
        // even dimensions, which H.264 requires.
        '-vf', `scale='min(1080,iw)':-2`,
        '-c:v', 'libx264',
        '-preset', config.ffmpeg.preset,
        '-b:v', `${videoKbps}k`,
        '-maxrate', `${Math.round(videoKbps * 1.5)}k`,
        '-bufsize', `${videoKbps * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', `${audioKbps}k`,
        // So it starts playing before it has finished downloading.
        '-movflags', '+faststart',
        out,
      ],
      config.ffmpeg.timeoutMs
    );

    const bytes = fs.statSync(out).size;
    return { out, bytes };
  };

  let first;
  try {
    first = await attempt(0.9);
  } catch (err) {
    const e = new Error(`Could not re-encode the video: ${err.message}`);
    e.code = 'transcode_failed';
    throw e;
  }
  log.info('re-encoded', {
    seconds: Math.round(seconds),
    mb: (first.bytes / 1048576).toFixed(1),
    target: (targetBytes / 1048576).toFixed(1),
  });
  if (first.bytes <= targetBytes) return first;

  // Missed. One harder pass, then give up rather than grind the box.
  remove(first.out);
  const second = await attempt(0.6).catch((err) => {
    const e = new Error(`Could not re-encode the video: ${err.message}`);
    e.code = 'transcode_failed';
    throw e;
  });
  log.info('re-encoded again', { mb: (second.bytes / 1048576).toFixed(1) });
  return second;
}

/**
 * Whatever came in, as something WhatsApp will take.
 *
 * Returns the path to send, how big it is, and whether it had to be
 * re-encoded — the caller decides between inline video, a document and a
 * link, and needs to know which of those the size represents.
 */
async function prepare(url) {
  const run = chain.then(() => prepareOnce(url));
  // The queue has to survive a failure, or one bad file blocks every later
  // send for the lifetime of the process.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function prepareOnce(url) {
  const src = await download(url);

  if (src.bytes <= config.send.maxMediaBytes) {
    return { file: src.file, bytes: src.bytes, mimeType: src.mimeType, transcoded: false, cleanup: () => remove(src.file) };
  }

  if (!config.ffmpeg.enabled) {
    // No encoder on this install: the old behaviour, which is a document up
    // to the document ceiling and a link past it.
    return { file: src.file, bytes: src.bytes, mimeType: src.mimeType, transcoded: false, cleanup: () => remove(src.file) };
  }

  try {
    const small = await shrink(src.file, config.send.maxMediaBytes);
    remove(src.file);
    return {
      file: small.out,
      bytes: small.bytes,
      mimeType: 'video/mp4',
      transcoded: true,
      cleanup: () => remove(small.out),
    };
  } catch (err) {
    // Re-encoding failed. The original is still here and may still be sendable
    // as a document, so it is handed back rather than thrown away.
    log.warn('falling back to the original file', { error: err.message });
    return { file: src.file, bytes: src.bytes, mimeType: src.mimeType, transcoded: false, cleanup: () => remove(src.file) };
  }
}

module.exports = { prepare, download, shrink, durationOf, remove };
