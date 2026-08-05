/**
 * GET /api/automation/health
 *
 * The first call to make when wiring n8n up: proves the key works, and reports
 * which pieces of the pipeline are actually configured.
 *
 * Every "is it set up?" question this answers is one that would otherwise
 * surface as a silent no-op at 6 PM — an empty queue because the migration
 * never ran, a notification that never arrives because SMTP is blank.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok } from "@/lib/automation-api";
import { env } from "@/lib/env";
import { queryOne, hasColumn } from "@/lib/db";
import { publishingReadiness } from "@/lib/instagram";
import { isStorageConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const [publishing, storage, autoPublishColumn] = await Promise.all([
    publishingReadiness(),
    isStorageConfigured(),
    hasColumn("clients", "auto_publish"),
  ]);

  // A database round trip, so this also proves the connection works rather
  // than only that the process is up.
  let clientsOptedIn = 0;
  let queueDepth = 0;
  if (autoPublishColumn) {
    const row = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM clients WHERE auto_publish = 1 AND status <> 'churned'"
    );
    clientsOptedIn = Number(row?.n ?? 0);
  }
  if (publishing.ready) {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deliverables
        WHERE instagram_status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()`
    );
    queueDepth = Number(row?.n ?? 0);
  }

  const checks = {
    database: true,
    publishing_schema: publishing.ready,
    r2_storage: storage,
    meta_token: env.meta.enabled,
    whatsapp: env.whatsapp.enabled,
    email_smtp: env.mail.enabled,
    ai_provider: env.openai.enabled || env.gemini.enabled,
  };

  return ok({
    app: env.appName,
    app_url: env.appUrl,
    checks,
    // Not a check — an install can be perfectly healthy with nobody opted in.
    clients_opted_in: clientsOptedIn,
    queue_depth: queueDepth,
    warnings: [
      publishing.ready ? null : publishing.reason,
      storage ? null : "Cloudflare R2 is not configured; videos have no fetchable URL.",
      env.mail.enabled ? null : "SMTP is off — client confirmation emails will be skipped.",
      env.whatsapp.enabled ? null : "WhatsApp is not configured in the portal (n8n may send it instead).",
    ].filter(Boolean),
  });
}
