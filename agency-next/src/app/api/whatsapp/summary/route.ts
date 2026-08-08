/**
 * POST /api/whatsapp/summary
 *
 * What a client gets when they type "status" in their group.
 *
 * A fixed answer rather than the AI one. The AI can already say roughly this,
 * but roughly is the problem: a client asking where their content stands is
 * asking a question with an exact answer, and a generated near-miss on
 * counts is worse than no reply. This reads the same numbers the boards do.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { clientForGroup } from "@/lib/whatsapp-approvals";
import { query } from "@/lib/db";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { groupId?: string };
  const groupId = String(body.groupId || "").trim();
  if (!groupId) return Response.json({ ok: false, error: "groupId is required" }, { status: 400 });

  const clientId = await clientForGroup(groupId);
  if (!clientId) {
    return Response.json({
      ok: true,
      text: "This group isn't linked to a client account yet — I can't look anything up. Someone from the team will pick this up.",
    });
  }

  const [counts] = await query<{
    posted: number;
    awaiting: number;
    scheduled: number;
    editing: number;
    needs_footage: number;
  }>(
    `SELECT
       COALESCE(SUM(status IN ('posted','completed')),0)                       AS posted,
       COALESCE(SUM(status IN ('content_review','review')),0)                  AS awaiting,
       COALESCE(SUM(status IN ('approved','scheduled')),0)                     AS scheduled,
       COALESCE(SUM(status IN ('raw_uploaded','editing','caption_ready')),0)   AS editing,
       COALESCE(SUM(status IN ('pending','waiting_for_raw')
                AND (raw_drive_link IS NULL OR raw_drive_link = '')),0)        AS needs_footage
     FROM deliverables
     WHERE client_id = ? AND month_key = DATE_FORMAT(CURDATE(),'%Y-%m')`,
    [clientId]
  );

  const next = await query<{ title: string; when: string | null }>(
    `SELECT title, COALESCE(scheduled_at, due_date) AS \`when\`
       FROM deliverables
      WHERE client_id = ? AND status IN ('approved','scheduled')
        AND COALESCE(scheduled_at, due_date) >= CURDATE()
      ORDER BY COALESCE(scheduled_at, due_date) ASC LIMIT 1`,
    [clientId]
  );

  const n = (v: unknown) => Number(v ?? 0);
  const lines = [`*This month so far*`];
  lines.push(`✅ ${n(counts?.posted)} posted`);
  if (n(counts?.awaiting)) lines.push(`👀 ${n(counts.awaiting)} waiting for your approval`);
  if (n(counts?.scheduled)) lines.push(`📅 ${n(counts.scheduled)} approved and scheduled`);
  if (n(counts?.editing)) lines.push(`✂️ ${n(counts.editing)} being edited`);
  if (n(counts?.needs_footage))
    lines.push(`📤 ${n(counts.needs_footage)} waiting on footage from you`);

  if (next.length && next[0].when) {
    lines.push("", `Next up: *${next[0].title}* on ${fmtDate(next[0].when)}.`);
  }
  if (n(counts?.awaiting)) {
    lines.push("", `Reply *OK* to approve, or *change* with what you'd like different.`);
  }

  return Response.json({ ok: true, text: lines.join("\n") });
}
