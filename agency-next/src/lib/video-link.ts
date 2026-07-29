/**
 * A permanent link to an uploaded video.
 *
 * The bucket is private, so the only URL R2 will serve is a signed one that
 * expires in hours. That is fine for playing a video on a page we render, and
 * useless as something to paste into a task, a message or a Zap — it would go
 * dead the same day.
 *
 * So the portal hands out its own address instead: /v/<id>?k=<token>. It never
 * changes, and following it mints a fresh signed URL on the spot.
 *
 * The token is the capability — anyone holding the link can watch the video,
 * the same bargain as a Google Drive "anyone with the link" share, which is
 * what these fields held before. It is derived from the object key, so
 * replacing a video invalidates every link to the old one.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

function sign(deliverableId: number, key: string): string {
  return createHmac("sha256", env.jwt.secret)
    .update(`video:${deliverableId}:${key}`)
    .digest("base64url")
    .slice(0, 32);
}

export function videoToken(deliverableId: number, key: string): string {
  return sign(deliverableId, key);
}

export function verifyVideoToken(
  deliverableId: number,
  key: string,
  token: string
): boolean {
  const expected = sign(deliverableId, key);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ""));
  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Absolute, so it survives being pasted into an email or a Zap. */
export function buildVideoPermalink(deliverableId: number, key: string): string {
  return `${env.appUrl}/v/${deliverableId}?k=${videoToken(deliverableId, key)}`;
}
