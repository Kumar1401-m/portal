/**
 * Talking to the WhatsApp approval service.
 *
 * The service lives outside Vercel — it drives a real browser and needs a
 * long-lived process, which serverless cannot provide. Everything the portal
 * needs from it goes through here so there is one place that knows the URL,
 * the token and the failure modes.
 *
 * Every call is failure-tolerant by design. The service being down must
 * degrade the portal (a button reports "can't reach WhatsApp") rather than
 * break it — an agency still needs to run when its WhatsApp box is rebooting.
 */
import "server-only";
import { env } from "./env";

export type ServiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; unreachable?: boolean; status?: number };

const TIMEOUT_MS = 90_000; // a video upload through WhatsApp is not fast

async function call<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<ServiceResult<T>> {
  if (!env.whatsappService.enabled) {
    return {
      ok: false,
      error:
        "The WhatsApp service is not configured. Set WHATSAPP_SERVICE_URL and WHATSAPP_SERVICE_TOKEN.",
      unreachable: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);

  try {
    const res = await fetch(`${env.whatsappService.url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.whatsappService.serviceToken}`,
        ...(init.headers || {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(body.error || `WhatsApp service returned ${res.status}`),
        // 5xx and 503 are worth retrying; a 4xx is a real refusal.
        unreachable: res.status >= 500,
      };
    }
    return { ok: true, ...(body as T) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      unreachable: true,
      error: aborted
        ? "The WhatsApp service didn't respond in time."
        : `Couldn't reach the WhatsApp service: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type WaServiceStatus = {
  state: string;
  connected: boolean;
  qrAvailable: boolean;
  me: { number: string | null; pushName: string | null } | null;
  lastError: string | null;
  lastReadyAt: string | null;
  reconnectAttempts: number;
};

export const getServiceStatus = () =>
  call<WaServiceStatus>("/api/status", { method: "GET", timeoutMs: 10_000 });

export const getQrCode = () =>
  call<{ dataUrl: string; generatedAt: string }>("/api/qr", {
    method: "GET",
    timeoutMs: 10_000,
  });

export const reconnectService = () =>
  call<WaServiceStatus>("/api/reconnect", { method: "POST", timeoutMs: 60_000 });

export const listServiceGroups = () =>
  call<{ count: number; groups: { groupId: string; name: string | null; participants: number | null }[] }>(
    "/api/groups",
    { method: "GET", timeoutMs: 30_000 }
  );

export const sendVideoToGroup = (payload: {
  videoCode: string;
  deliverableId: number;
  groupId: string;
  videoUrl: string;
  caption: string;
  filename?: string;
}) =>
  call<{ messageId: string | null; attempts: number }>("/api/send-video", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const sendTextToGroup = (groupId: string, text: string) =>
  call<{ messageId: string | null }>("/api/send-text", {
    method: "POST",
    body: JSON.stringify({ groupId, text }),
    timeoutMs: 30_000,
  });
