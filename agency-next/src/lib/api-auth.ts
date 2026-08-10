/**
 * Shared-secret auth for the machine-facing REST API. Deliberately separate
 * from the session-cookie auth in auth.ts — n8n and the WhatsApp service call
 * these as plain authenticated APIs, not as logged-in browser users.
 */
import "server-only";
import { env } from "./env";

/**
 * The n8n automation API (src/app/api/automation/*), against its own key.
 *
 * Header-only, and now the only way in. The Zapier guard that used to sit here
 * also accepted a `?key=` query param, because some Zapier trigger types could
 * not set headers — which meant a credential that can publish to a client's
 * Instagram account travelling in a URL, through access logs and proxy
 * history. Zapier is gone and so is that door: every n8n HTTP Request node can
 * set a header.
 */
export function isAuthorizedAutomationRequest(req: Request): boolean {
  if (!env.automation.enabled) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : header;
  const key = bearer || req.headers.get("x-api-key") || "";
  return key.length > 0 && timingSafeEqual(key, env.automation.apiKey);
}

/**
 * Auth for scheduled invocations — Vercel Cron and the n8n workflows.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` and nothing else —
 * no body, no custom headers — so a cron route can't use the automation guard
 * as it stands. The automation key is still accepted, which is what makes
 * these endpoints testable by hand and callable from n8n, where most of the
 * schedules now live.
 *
 * With neither secret configured this returns false, so an unconfigured
 * deployment exposes nothing rather than defaulting to open.
 */
export function isAuthorizedCronRequest(req: Request): boolean {
  const header = req.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : header;
  const key = bearer || req.headers.get("x-api-key") || "";
  if (!key) return false;
  if (env.automation.cronSecret && timingSafeEqual(key, env.automation.cronSecret)) return true;
  return isAuthorizedAutomationRequest(req);
}

/**
 * Auth for callbacks from the WhatsApp approval service (src/app/api/whatsapp/*).
 *
 * Its own key again, not shared with n8n: this one is held by a
 * container running an unofficial browser automation, which is the credential
 * in this system most likely to need revoking in a hurry.
 */
export function isAuthorizedWhatsAppRequest(req: Request): boolean {
  const expected = env.whatsappService.inboundKey;
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : header;
  const key = bearer || req.headers.get("x-api-key") || "";
  return key.length > 0 && timingSafeEqual(key, expected);
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
