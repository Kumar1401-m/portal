/**
 * Shared-secret auth for the Zapier-facing REST API. Deliberately separate
 * from the session-cookie auth in auth.ts — Zapier calls these as a plain
 * authenticated API, not as a logged-in browser user.
 */
import "server-only";
import { env } from "./env";

/**
 * True if the request carries the configured Zapier API key — via the
 * Authorization header, an X-Api-Key header, or a `?key=` query param.
 * The query param exists because some Zapier trigger types (e.g. Webhooks by
 * Zapier "Retrieve Poll") don't reliably expose custom-header configuration,
 * so putting the key directly in the URL is the dependable fallback.
 */
export function isAuthorizedZapierRequest(req: Request): boolean {
  if (!env.zapier.enabled) return false;
  const header = req.headers.get("authorization") || "";
  const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : header;
  const url = new URL(req.url);
  const key = bearerToken || req.headers.get("x-api-key") || url.searchParams.get("key") || "";
  return key.length > 0 && timingSafeEqual(key, env.zapier.apiKey);
}

/** Constant-time string compare so key checks don't leak timing info. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}
