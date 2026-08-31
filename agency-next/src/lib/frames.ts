/**
 * Decoding a video into frames, in the browser.
 *
 * The model reads images and hears audio; it has no video input. So something
 * has to turn a reel into pictures, and there are only three places that could
 * happen:
 *
 *   **A server with ffmpeg.** The portal runs on serverless functions, which
 *   have no ffmpeg and no room to download a 60 MB reel to feed it.
 *
 *   **A separate worker box.** A second thing to deploy, pay for and watch,
 *   to do work that is already possible for free.
 *
 *   **The browser that is uploading the file.** It is holding the bytes
 *   already, it has a hardware video decoder, and it does the work on the
 *   editor's own machine while they wait for the upload anyway.
 *
 * The third is not a compromise — it is strictly the best of the three. The
 * whole of this module is `<video>` and `<canvas>`, both of which every
 * browser has had for fifteen years, and no dependency was added for it.
 *
 * Deliberately not `server-only`: this is the one piece that must run on the
 * client, and it touches nothing but the DOM.
 */

/**
 * How many frames are decoded from a video, and why that is the number.
 *
 * Too few and the end of the video is missed, which is exactly where the
 * branding lock-up lives — the one thing this is most often asked to read.
 * Too many and a high-detail frame each costs real tokens for a view that is
 * nearly identical to the one before it, on a balance that is not large.
 *
 * Twelve covers a 30-second reel at roughly one frame every two and a half
 * seconds, which is close enough that a title card cannot appear and vanish
 * between two of them.
 *
 * A literal, not an env var, and that is deliberate. This module is imported
 * by the browser and by the server, and Next only substitutes `NEXT_PUBLIC_`
 * variables into a client bundle — so an override would have applied on the
 * server and silently not in the browser. The two would then disagree about
 * how many frames exist: the decoder would make eight and the reader would
 * take twelve, which fails as a missing frame rather than as a bad setting.
 */
export const MAX_FRAMES = 12;

/**
 * The longest edge of a decoded frame, in pixels.
 *
 * Big enough to read a phone number along a footer, small enough that twelve
 * of them fit comfortably in one request. The browser downscales to this
 * before encoding, so a 4K master costs no more than a 1080p one.
 */
export const FRAME_EDGE = 960;
/** One decoded frame: a JPEG data URI, and where in the video it came from. */
export type Frame = { dataUrl: string; atSeconds: number };

/**
 * Evenly spaced moments across a video's runtime, first second to last.
 *
 * The first and last are pulled slightly inside the ends on purpose. Seeking
 * to exactly 0 can land on a black leader frame, and exactly `duration` often
 * fails to render at all — so both would spend a frame of the budget on a
 * blank rectangle. Nudging in by a few percent costs nothing and reliably
 * catches the opening shot and the closing lock-up, which is where the
 * branding is.
 */
export function frameTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count < 1) return [0];
  if (count === 1) return [duration / 2];
  const first = Math.min(0.05 * duration, 0.4);
  const last = Math.max(duration - Math.min(0.05 * duration, 0.4), first);
  const step = (last - first) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((first + i * step).toFixed(3)));
}

/** Fit inside a square of `edge`, never enlarging a video smaller than that. */
export function fitWithin(w: number, h: number, edge: number): { w: number; h: number } {
  if (!w || !h) return { w: edge, h: edge };
  const scale = Math.min(1, edge / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/**
 * Decode `count` frames from a video file, in order.
 *
 * Seeks and captures one at a time rather than playing through: a 40-second
 * reel would otherwise take 40 seconds, and this takes about one. Each seek
 * resolves on `seeked`, which fires once the frame at that time is actually
 * decoded and ready to paint — drawing before it lands is how a strip of
 * frames comes back as eight copies of the same picture.
 *
 * Never throws. A codec the browser cannot decode, a file that turns out not
 * to be a video, a canvas the browser refuses to read back — all of them
 * return the frames captured so far, which may be none. The caller treats an
 * empty result as "analyse from the audio instead", because a video uploaded
 * successfully must never be failed by the extra thing we tried to do with it.
 */
export async function extractFrames(
  file: Blob,
  count: number,
  edge: number,
  onProgress?: (done: number, total: number) => void
): Promise<Frame[]> {
  if (typeof document === "undefined") return [];

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  // Required on iOS, where a video that wants fullscreen cannot be decoded
  // into a canvas at all.
  video.playsInline = true;
  video.crossOrigin = "anonymous";

  const frames: Frame[] = [];
  try {
    video.src = url;
    await once(video, "loadeddata", 30_000);

    const duration = video.duration;
    // A stream with no known duration cannot be sampled across its length;
    // one frame from the start is still better than nothing.
    const times = frameTimes(Number.isFinite(duration) ? duration : 0, count);

    const { w, h } = fitWithin(video.videoWidth, video.videoHeight, edge);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    for (const at of times) {
      try {
        video.currentTime = at;
        await once(video, "seeked", 15_000);
        ctx.drawImage(video, 0, 0, w, h);
        /*
         * 0.72 rather than maximum quality. These are read by a model, not
         * looked at by a person, and the artefacts that appear below about
         * 0.6 are exactly the ones that blur small text — which is the whole
         * job. Above 0.8 the file doubles and reads no better.
         */
        frames.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.72), atSeconds: at });
        onProgress?.(frames.length, times.length);
      } catch {
        // One bad seek is not a reason to lose the frames that worked.
      }
    }
  } catch {
    /* fall through to whatever was captured */
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }

  return frames;
}

/** Resolve on an event, or reject on error or after `ms`. */
function once(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
      fn();
    };
    const ok = () => done(resolve);
    const bad = () => done(() => reject(new Error(`video ${event} failed`)));
    const timer = setTimeout(bad, ms);
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

/**
 * How much base64 goes in one Server Action call.
 *
 * Next caps an action's request body at 1 MB, and going over it is not a
 * failure the action can report: the framework rejects the request before the
 * function runs, and the browser is shown an opaque "an error occurred in the
 * Server Components render" that names neither the size nor the action.
 * Twelve frames is roughly 2 MB, so the whole strip never arrived at all.
 *
 * 700 KB leaves room for the multipart framing without having to be exact
 * about it.
 */
export const CHUNK_BYTES = 700_000;

/**
 * A frame cannot be split, so one frame is also the floor on a batch: an
 * image larger than this would be sent alone and still be refused. At 960px
 * and quality 0.72 nothing comes close, and dropping the one frame that did
 * beats losing the eleven around it.
 */
export const MAX_ONE = 900_000;

/**
 * Group frames into batches that each fit in one request.
 *
 * Cut by actual byte count rather than a fixed count of frames, because frame
 * sizes vary several-fold with how busy the picture is — a fixed twelve fits
 * one video and not the next, which is the kind of limit that works in
 * testing and fails on a real reel.
 *
 * Every batch is a run of *consecutive* frames, and that is load-bearing: the
 * server names each file by its position in the whole strip and is told only
 * where the batch starts. A skipped oversized frame therefore ends the batch
 * rather than being stepped over, or every frame after it would be filed one
 * place early and overwrite its neighbour.
 */
export function planBatches(
  sizes: number[],
  chunk = CHUNK_BYTES,
  maxOne = MAX_ONE
): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let bytes = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    bytes = 0;
  };

  for (let i = 0; i < sizes.length; i++) {
    if (!(sizes[i] > 0) || sizes[i] > maxOne) {
      flush();
      continue;
    }
    if (cur.length && bytes + sizes[i] > chunk) flush();
    cur.push(i);
    bytes += sizes[i];
  }
  flush();
  return out;
}
