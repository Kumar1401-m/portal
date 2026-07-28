/**
 * AWS Signature V4 — the subset needed to talk to S3-compatible storage
 * (Cloudflare R2). Pure functions with an injectable clock, so the signing can
 * be verified against a reference implementation without any network or config.
 *
 * Hand-rolled rather than pulling in the AWS SDK, which would add megabytes to
 * the serverless bundle for two request shapes.
 */
import crypto from "crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256Hex = (data: string) => crypto.createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data, "utf8").digest();

/**
 * RFC 3986 encoding. encodeURIComponent leaves !'()* alone but AWS expects them
 * percent-encoded; a mismatch silently produces a signature that won't verify.
 */
export function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Each path segment is encoded, the separators are not. */
export const encodePath = (path: string) => path.split("/").map(encodeRfc3986).join("/");

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** `20260728T101500Z` and `20260728` for a given instant. */
export function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export type SignArgs = {
  /** Bucket host, e.g. `<account>.r2.cloudflarestorage.com`. */
  host: string;
  /** Already-unencoded path, e.g. `/bucket/videos/1/2.mp4`. */
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
};

/**
 * Query-signed URL. Only `host` is signed, so the browser may add its own
 * headers (Content-Type on an upload, Range on a video seek) without
 * invalidating the signature.
 */
export function presign(
  method: "PUT" | "GET",
  args: SignArgs & { expiresIn: number }
): string {
  const { host, path, accessKeyId, secretAccessKey, region, service, date, expiresIn } = args;
  const { amzDate, dateStamp } = amzDates(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = encodePath(path);

  const params: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
    // Hoisted into the query exactly as AWS's own signer does — lowercase, and
    // therefore sorting last. The canonical query is case-sensitive, so the
    // casing here is part of the signature.
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, "utf8")
    .digest("hex");

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const presignPut = (args: SignArgs & { expiresIn: number }) => presign("PUT", args);
export const presignGet = (args: SignArgs & { expiresIn: number }) => presign("GET", args);

/** Header-signed DELETE (no body), for removing a replaced object. */
export function signDelete(args: SignArgs): { url: string; headers: Record<string, string> } {
  const { host, path, accessKeyId, secretAccessKey, region, service, date } = args;
  const { amzDate, dateStamp } = amzDates(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = encodePath(path);
  const payloadHash = sha256Hex("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    "",
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      Authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}
