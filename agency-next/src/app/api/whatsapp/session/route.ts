/**
 * POST /api/whatsapp/session
 *
 * Session heartbeat from the service: connected, disconnected, QR required.
 *
 * Mirrored into the database rather than read live, because the settings page
 * runs on Vercel and cannot hold a socket open to the service. Storing the
 * last known state means the page renders health instantly and, crucially,
 * shows a *stale* heartbeat when the service has died — which is otherwise
 * indistinguishable from an idle one.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { saveSessionHealth } from "@/lib/whatsapp-approvals";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    await saveSessionHealth({
      state: str(body.state) ?? "unknown",
      // The heartbeat sends the whole status object, where the identity lives
      // under `me`; a state change sends the fields flat.
      phoneNumber: str(body.phoneNumber) ?? str((body.me as Record<string, unknown>)?.number),
      pushName: str(body.pushName) ?? str((body.me as Record<string, unknown>)?.pushName),
      qrAvailable: body.qrAvailable === true,
      lastError: str(body.lastError),
      lastReadyAt: str(body.lastReadyAt),
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.warn("[whatsapp] session write failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: true, recorded: false });
  }
}
