/**
 * POST /api/whatsapp/footage
 *
 * A client drops a Drive link in their group and it becomes footage on a task.
 *
 * The portal has a page for this, and clients do not use it — they are already
 * in WhatsApp, replying to the message that asked. Making the reply itself the
 * submission removes the only step that was ever going to be skipped.
 *
 * Attaches to the task the client is most likely to mean: the oldest one still
 * waiting on footage. Not a guess worth agonising over — the alternative is
 * asking a client to pick from a numbered list, and the team can move a link
 * in seconds if it lands on the wrong row.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { clientForGroup } from "@/lib/whatsapp-approvals";
import { query, execute } from "@/lib/db";
import { notifyAdmins } from "@/lib/notify";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

/** Statuses a link may still be attached to — mirrors the portal's own rule. */
const ACCEPTS_RAW = ["waiting_for_raw", "pending"];

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as {
    groupId?: string;
    link?: string;
    senderName?: string;
  };
  const groupId = String(body.groupId || "").trim();
  const link = String(body.link || "").trim();

  if (!groupId || !/^https?:\/\/.+/i.test(link)) {
    return Response.json({ ok: false, error: "groupId and a http(s) link are required" }, { status: 400 });
  }

  const clientId = await clientForGroup(groupId);
  if (!clientId) return Response.json({ ok: true, attached: false, text: null });

  const [task] = await query<{ id: number; title: string }>(
    `SELECT id, title FROM deliverables
      WHERE client_id = ? AND status IN (${ACCEPTS_RAW.map(() => "?").join(",")})
        AND (raw_drive_link IS NULL OR raw_drive_link = '')
      ORDER BY due_date IS NULL, due_date ASC, id ASC LIMIT 1`,
    [clientId, ...ACCEPTS_RAW]
  );

  // Nothing is waiting on footage. Say nothing rather than something wrong —
  // clients share links in a group for all sorts of reasons, and a bot
  // announcing "received!" over a link to a news article is worse than silence.
  if (!task) return Response.json({ ok: true, attached: false, text: null });

  await execute(
    "UPDATE deliverables SET raw_drive_link = ?, status = 'raw_uploaded' WHERE id = ?",
    [link, task.id]
  );

  await notifyAdmins(
    "general",
    "Raw footage received on WhatsApp",
    `"${task.title}" — the client sent a footage link in their WhatsApp group.`,
    `/deliverables/${task.id}`
  );

  for (const p of ["/deliverables", "/today", "/dashboard"]) revalidatePath(p);

  const [more] = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliverables
      WHERE client_id = ? AND status IN (${ACCEPTS_RAW.map(() => "?").join(",")})
        AND (raw_drive_link IS NULL OR raw_drive_link = '')`,
    [clientId, ...ACCEPTS_RAW]
  );
  const left = Number(more?.n) || 0;

  return Response.json({
    ok: true,
    attached: true,
    deliverableId: task.id,
    text:
      `Got it — thanks! Attached to *${task.title}* and the team can start editing.` +
      (left ? `\n\nStill waiting on footage for ${left} more.` : ""),
  });
}
