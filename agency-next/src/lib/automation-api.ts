/**
 * Shared plumbing for the n8n automation API (src/app/api/automation/*).
 *
 * These endpoints are called by a machine, so they answer differently from the
 * rest of the app: always JSON, always a stable shape, and an error the
 * workflow can branch on rather than an HTML error page. Every response
 * carries `ok`, so an n8n IF node only ever has to look at one field.
 */
import "server-only";
import { isAuthorizedAutomationRequest, unauthorized } from "./api-auth";

export type ApiOk<T> = { ok: true } & T;
export type ApiErr = { ok: false; error: string; code?: string };

export function ok<T extends object>(data: T, status = 200): Response {
  return Response.json({ ok: true, ...data }, { status });
}

export function fail(error: string, status = 400, code?: string): Response {
  return Response.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/**
 * Guard + JSON body in one step.
 *
 * Returns either a ready-made `response` to send straight back, or the parsed
 * `body`. Keeping both the auth check and the parse here means a route can
 * never accidentally read a body it hasn't authorised.
 */
export async function readAuthorized(
  request: Request
): Promise<{ response: Response; body?: never } | { response?: never; body: Record<string, unknown> }> {
  if (!isAuthorizedAutomationRequest(request)) return { response: unauthorized() };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { response: fail("Body must be a JSON object.", 400, "bad_body") };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { response: fail("Invalid JSON body.", 400, "bad_json") };
  }
}

/** Auth guard for GET routes, which have no body to read. */
export function guard(request: Request): Response | null {
  return isAuthorizedAutomationRequest(request) ? null : unauthorized();
}

/* ------------------------------ Field coercion ------------------------------ */
/* n8n sends whatever the previous node produced — a number can arrive as a
   string, an absent field as an empty string. These normalise rather than
   reject, so a workflow doesn't fail on a cosmetic type difference. */

export function asInt(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Normalise a timestamp to a MySQL DATETIME in UTC.
 *
 * Instagram returns ISO-8601 with an offset (`2026-08-01T18:30:00+0000`);
 * storing that verbatim in a DATETIME column silently drops the offset and
 * shifts the post by hours. Parsing to an epoch first makes the conversion
 * explicit.
 */
export function asDateTime(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  // Already a MySQL DATETIME — leave it alone.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Normalise to YYYY-MM-DD, defaulting to today (UTC). */
export function asDate(v: unknown): string {
  const s = asStr(v);
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = s ? Date.parse(s) : NaN;
  if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}
