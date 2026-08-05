/**
 * Proving the R2 credentials actually work.
 *
 * S3-compatible auth fails with almost no useful signal: five different
 * mistakes — wrong account id, wrong key, wrong secret, missing permission,
 * bucket that doesn't exist — can all surface as the same
 * `SignatureDoesNotMatch` or a bare 403. Someone then edits fields at random.
 *
 * So this runs the real round trip the portal depends on (PUT, GET, DELETE)
 * and maps each failure onto the specific field that causes it.
 */
import "server-only";
import { getR2Config } from "./storage";
import { presignPut, presignGet, signDelete } from "./sigv4";

const REGION = "auto";
const SERVICE = "s3";

export type CheckStep = {
  label: string;
  ok: boolean;
  detail?: string;
  /** Which setting to go and fix, when we can tell. */
  fix?: string;
};

export type StorageCheck = {
  ok: boolean;
  steps: CheckStep[];
  /** Set when the bucket serves a public URL, since that changes behaviour. */
  publicUrlWorks?: boolean;
};

/**
 * Turn an S3 error into the field that's actually wrong.
 *
 * R2 returns XML; the code inside it is far more specific than the status.
 */
function diagnose(status: number, body: string): { detail: string; fix?: string } {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] || "";

  if (code === "SignatureDoesNotMatch") {
    return {
      detail: "R2 rejected the signature.",
      fix: "The secret access key is wrong — copy it again, it's only shown once.",
    };
  }
  if (code === "InvalidAccessKeyId") {
    return { detail: "R2 doesn't recognise that key.", fix: "Check the access key ID." };
  }
  if (code === "NoSuchBucket") {
    return {
      detail: "That bucket doesn't exist on this account.",
      fix: "Check the bucket name, and that it belongs to this account ID.",
    };
  }
  if (code === "AccessDenied") {
    return {
      detail: "The key exists but isn't allowed to do this.",
      fix: "The API token needs Object Read & Write, not just Read.",
    };
  }
  if (status === 404) {
    return {
      detail: "R2 returned 404 for the bucket URL.",
      fix: "Usually a wrong account ID, or a bucket name with a typo.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      detail: code ? `R2 said ${code}.` : "R2 refused the request.",
      fix: "Check the access key, secret, and that the token covers this bucket.",
    };
  }
  return { detail: code ? `R2 said ${code} (HTTP ${status}).` : `HTTP ${status}.` };
}

/**
 * Write, read and delete a tiny object.
 *
 * Deliberately exercises all three: a token with read-only permission passes a
 * GET check and then fails silently on the first real upload, which is exactly
 * the failure this is meant to catch before a video is lost.
 */
export async function checkStorage(): Promise<StorageCheck> {
  const steps: CheckStep[] = [];

  const cfg = await getR2Config();
  if (!cfg) {
    return {
      ok: false,
      steps: [
        {
          label: "Settings filled in",
          ok: false,
          detail: "Account ID, bucket, access key or secret is missing.",
          fix: "Fill in all four fields above and save.",
        },
      ],
    };
  }
  steps.push({ label: "Settings filled in", ok: true });

  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  // A key under a dedicated prefix, so a leftover from a failed check is
  // obvious and can never collide with a real video.
  const key = `_healthcheck/portal-${Date.now()}.txt`;
  const body = `portal storage check ${new Date().toISOString()}`;
  const signArgs = {
    host,
    path: `/${cfg.bucket}/${key}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: REGION,
    service: SERVICE,
    date: new Date(),
  };

  /* ---- Write ---- */
  try {
    const putUrl = presignPut({ ...signArgs, expiresIn: 300 });
    const res = await fetch(putUrl, { method: "PUT", body });
    if (res.ok) {
      steps.push({ label: "Upload a test file", ok: true });
    } else {
      const { detail, fix } = diagnose(res.status, await res.text());
      steps.push({ label: "Upload a test file", ok: false, detail, fix });
      // Everything after this depends on the write, so stop here.
      return { ok: false, steps };
    }
  } catch (err) {
    steps.push({
      label: "Upload a test file",
      ok: false,
      detail: err instanceof Error ? err.message : "Network error",
      fix: "Check the account ID — it forms the hostname R2 is reached on.",
    });
    return { ok: false, steps };
  }

  /* ---- Read back ---- */
  try {
    const getUrl = presignGet({ ...signArgs, expiresIn: 300 });
    const res = await fetch(getUrl);
    const text = res.ok ? await res.text() : "";
    if (res.ok && text === body) {
      steps.push({ label: "Read it back", ok: true });
    } else if (res.ok) {
      steps.push({
        label: "Read it back",
        ok: false,
        detail: "The file came back with different contents.",
      });
    } else {
      const { detail, fix } = diagnose(res.status, await res.text());
      steps.push({ label: "Read it back", ok: false, detail, fix });
    }
  } catch (err) {
    steps.push({
      label: "Read it back",
      ok: false,
      detail: err instanceof Error ? err.message : "Network error",
    });
  }

  /* ---- Public URL, when one is configured ---- */
  let publicUrlWorks: boolean | undefined;
  if (cfg.publicBaseUrl) {
    try {
      const res = await fetch(`${cfg.publicBaseUrl}/${key}`);
      publicUrlWorks = res.ok;
      steps.push({
        label: "Public URL serves the file",
        ok: res.ok,
        detail: res.ok
          ? undefined
          : `The bucket's public URL returned ${res.status}.`,
        fix: res.ok
          ? undefined
          : "Either enable public access on the bucket, or clear this field — the portal will sign short-lived links instead.",
      });
    } catch {
      publicUrlWorks = false;
      steps.push({
        label: "Public URL serves the file",
        ok: false,
        detail: "Couldn't reach that URL.",
        fix: "Check the public base URL, or clear it to use signed links.",
      });
    }
  } else {
    // Not a failure — a private bucket is a supported, and safer, setup.
    steps.push({
      label: "Public URL",
      ok: true,
      detail: "Not set — the portal will hand out short-lived signed links. That's fine.",
    });
  }

  /* ---- Clean up after ourselves ---- */
  try {
    const { url, headers } = signDelete(signArgs);
    const res = await fetch(url, { method: "DELETE", headers });
    steps.push({
      label: "Delete the test file",
      ok: res.ok,
      detail: res.ok ? undefined : "Couldn't remove it — check for _healthcheck/ in the bucket.",
      fix: res.ok ? undefined : "The token needs delete permission to replace videos cleanly.",
    });
  } catch {
    steps.push({ label: "Delete the test file", ok: false, detail: "Delete failed." });
  }

  return { ok: steps.every((s) => s.ok), steps, publicUrlWorks };
}
