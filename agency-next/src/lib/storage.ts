/**
 * Cloudflare R2 video hosting.
 *
 * Vercel caps a request body at ~4.5 MB, so a finished video can't be uploaded
 * *through* the server. Instead the server signs a short-lived PUT URL and the
 * browser uploads straight to R2 — the bytes never touch our hosting, and the
 * upload isn't limited by any serverless request size.
 *
 * R2 speaks the S3 API; the signing lives in ./sigv4.
 */
import "server-only";
import { getSettings } from "./settings";
import { presignPut, signDelete, encodePath } from "./sigv4";

const REGION = "auto"; // R2 is region-less, but the signature still needs a value.
const SERVICE = "s3";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
};

/** Config from Settings, or null when R2 hasn't been set up yet. */
export async function getR2Config(): Promise<R2Config | null> {
  const s = await getSettings();
  const cfg: R2Config = {
    accountId: s.r2_account_id.trim(),
    bucket: s.r2_bucket.trim(),
    accessKeyId: s.r2_access_key_id.trim(),
    secretAccessKey: s.r2_secret_access_key.trim(),
    publicBaseUrl: s.r2_public_base_url.trim().replace(/\/+$/, ""),
  };
  const complete =
    cfg.accountId && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey && cfg.publicBaseUrl;
  return complete ? cfg : null;
}

export async function isStorageConfigured(): Promise<boolean> {
  return (await getR2Config()) !== null;
}

const hostFor = (cfg: R2Config) => `${cfg.accountId}.r2.cloudflarestorage.com`;

/** A short-lived PUT the browser can upload to directly. */
export async function presignUpload(
  key: string,
  expiresInSeconds = 900
): Promise<{ uploadUrl: string; publicUrl: string } | null> {
  const cfg = await getR2Config();
  if (!cfg) return null;

  const uploadUrl = presignPut({
    host: hostFor(cfg),
    path: `/${cfg.bucket}/${key}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: REGION,
    service: SERVICE,
    date: new Date(),
    expiresIn: expiresInSeconds,
  });

  return { uploadUrl, publicUrl: `${cfg.publicBaseUrl}/${encodePath(key)}` };
}

/**
 * Stable, collision-safe object key for a task's delivered video.
 *
 * Deliberately restricted to `[a-z0-9/._-]`: the uploader's filename is never
 * used verbatim, only its extension, and even that is validated. Keys are
 * always built server-side, so nothing user-supplied reaches the signer — which
 * keeps us clear of the percent-encoding corners of SigV4 canonicalisation.
 */
export function buildVideoKey(clientId: number, deliverableId: number, filename: string): string {
  const ext = (filename.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] || "mp4").toLowerCase();
  return `videos/${Math.trunc(clientId)}/${Math.trunc(deliverableId)}-${Date.now()}.${ext}`;
}

/** Guard for the invariant above — a key must be safe to sign as-is. */
export const isSafeKey = (key: string) => /^[a-z0-9][a-z0-9/._-]*$/.test(key);

/** Remove an object (used when a video is replaced). Never throws. */
export async function deleteObject(key: string): Promise<boolean> {
  const cfg = await getR2Config();
  if (!cfg || !key) return false;

  const { url, headers } = signDelete({
    host: hostFor(cfg),
    path: `/${cfg.bucket}/${key}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: REGION,
    service: SERVICE,
    date: new Date(),
  });

  try {
    const res = await fetch(url, { method: "DELETE", headers });
    return res.ok;
  } catch {
    return false;
  }
}
