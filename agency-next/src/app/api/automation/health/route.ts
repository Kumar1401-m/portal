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
import { nowUtc } from "@/lib/posting";
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
        WHERE instagram_status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
      [nowUtc()]
    );
    queueDepth = Number(row?.n ?? 0);
  }

  /*
   * How far the database's wall clock is from ours.
   *
   * Reported because it decides whether scheduled posting works at all, and
   * nothing on any screen could tell you. Every scheduled time is written by
   * the app in UTC; a database keeping some other wall clock used to make
   * every post look due by exactly that much — a 6pm reel going out at half
   * past twelve on a live client account, with nothing anywhere saying why.
   *
   * The queries that matter no longer ask the database what time it is, so a
   * skew here is now a curiosity rather than a fault. It is still worth
   * seeing: a database in the wrong timezone will make CURDATE() comparisons
   * elsewhere disagree with the calendar near midnight.
   */
  let clockSkewMinutes: number | null = null;
  try {
    const row = await queryOne<{ db_now: string }>("SELECT NOW() AS db_now");
    if (row?.db_now) {
      const dbMs = Date.parse(`${String(row.db_now).replace(" ", "T")}Z`);
      if (!Number.isNaN(dbMs)) clockSkewMinutes = Math.round((dbMs - Date.now()) / 60000);
    }
  } catch {
    /* a diagnostic must never be the reason health reports unhealthy */
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
    /** Database wall clock minus ours, in minutes. 0 means both are on UTC. */
    db_clock_skew_minutes: clockSkewMinutes,
    warnings: [
      publishing.ready ? null : publishing.reason,
      clockSkewMinutes !== null && Math.abs(clockSkewMinutes) > 5
        ? `The database clock is ${clockSkewMinutes > 0 ? "ahead of" : "behind"} UTC by ` +
          `${Math.abs(clockSkewMinutes)} minutes. Scheduling no longer depends on it, but ` +
          `date comparisons near midnight will follow that clock rather than the calendar.`
        : null,
      storage ? null : "Cloudflare R2 is not configured; videos have no fetchable URL.",
      env.mail.enabled ? null : "SMTP is off — client confirmation emails will be skipped.",
      env.whatsapp.enabled ? null : "WhatsApp is not configured in the portal (n8n may send it instead).",
    ].filter(Boolean),
  });
}
