/**
 * Getting the speech out of a video, in the browser, whatever the video weighs.
 *
 * Transcription takes an mp4 whole, which is elegant right up to the point a
 * reel is finished at a decent bitrate: the transcription call refuses
 * anything past a size limit, so a 66 MB video was captioned from its
 * pictures alone and the caption simply never mentioned what anybody said.
 * Nothing failed — it just quietly got worse, which is the failure mode this
 * portal keeps having to design out.
 *
 * The size is almost entirely picture. A minute of 1080p is tens of megabytes;
 * the same minute of speech, at the rate speech recognition actually wants, is
 * under two. So the fix is not to send less video, it is to stop sending video
 * at all — decode the audio track, downmix it to one channel at 16 kHz, and
 * send that.
 *
 * Done here rather than on a server for the same reason the frames are: the
 * browser is holding the file, has the decoder built in, and does the work on
 * the editor's machine while they are waiting for an upload anyway. A server
 * would need ffmpeg and a copy of the video.
 *
 * Done for *every* video, not only the ones over the limit. A size check would
 * be one more branch, and it would leave the audio of a previous cut sitting
 * under a deliverable that replaced it with something small enough not to need
 * extracting. Always extracting means the audio on a task is always the audio
 * of the video on that task.
 *
 * Deliberately not `server-only`: like `frames.ts`, this is the piece that has
 * to run on the client, and it touches nothing but Web Audio.
 */

/**
 * 16 kHz, mono.
 *
 * What speech recognition resamples to anyway, so anything above it is paid
 * for and thrown away. Sixteen-bit PCM at this rate is 32 KB a second, which
 * puts a little over thirteen minutes of speech inside the 25 MB ceiling —
 * comfortably more than any reel, and the point at which this stops working
 * is worth knowing rather than discovering.
 */
export const AUDIO_RATE = 16_000;

/** Where a deliverable's extracted speech lives. One per task, overwritten. */
export const audioKey = (deliverableId: number): string =>
  `audio/${Math.trunc(deliverableId)}.wav`;

/**
 * The ceiling on one transcription, repeated here.
 *
 * The authority is `MAX_TRANSCRIBE_BYTES` in `model.ts`, which cannot be
 * imported: that module is `server-only`, and pulling it into a client bundle
 * breaks the build. So it is written twice on purpose, and the browser's copy
 * is used for one thing only — refusing to upload audio the server could not
 * send on.
 *
 * Inline audio is base64, a third bigger than the bytes it carries, inside a
 * request that has to stay under 20 MB. Fourteen leaves room for the prompt.
 */
export const MAX_AUDIO_BYTES = 14 * 1024 * 1024;

/**
 * Decode a video's audio into a mono 16 kHz WAV.
 *
 * Never throws. A codec the browser cannot decode, a file with no audio track
 * at all, a machine that runs out of memory on a very long master — all of
 * them return null, and the analysis falls back to transcribing the video
 * itself. That fallback works for anything inside the 25 MB limit, so the
 * worst case here is exactly the behaviour that existed before.
 */
export async function extractAudio(file: Blob, rate = AUDIO_RATE): Promise<Blob | null> {
  if (typeof window === "undefined") return null;

  const Offline: typeof OfflineAudioContext | undefined =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline) return null;

  try {
    const bytes = await file.arrayBuffer();

    /*
     * Decoded first, then re-rendered — two passes, and the second is the one
     * that does the work asked of it.
     *
     * `decodeAudioData` is specified to resample to the context's rate, and
     * Safari has not always done so. Rendering the decoded buffer through a
     * one-channel context at the target rate resamples and downmixes for
     * certain, on every browser, and costs one pass over audio that is
     * already in memory.
     */
    const decoded = await new Offline(1, 1, rate).decodeAudioData(bytes);
    if (!decoded.length) return null;

    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const out = new Offline(1, frames, rate);
    const source = out.createBufferSource();
    source.buffer = decoded;
    source.connect(out.destination);
    source.start();
    const mono = await out.startRendering();

    const wav = encodeWav(mono.getChannelData(0), rate);
    return wav.size > MAX_AUDIO_BYTES ? null : wav;
  } catch {
    return null;
  }
}

/**
 * Float samples to a 16-bit PCM WAV.
 *
 * WAV because it is the one format that needs no encoder: a 44-byte header
 * and the samples. An mp3 or an opus file would be a fifth of the size and
 * would mean shipping an encoder to do it, for a file that is uploaded once
 * and read once.
 */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per sample
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample even slightly outside ±1 wraps to the
    // opposite extreme as a 16-bit integer, which is heard as a click.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([bytes], { type: "audio/wav" });
}
