/**
 * The content desk: writing the month's briefs, and getting them signed off.
 *
 * This is its own board rather than a status on Today's Tasks. Writing content
 * is not the same job as chasing a design or a cut — it is done in one sitting,
 * for a client at a time, usually for the whole month at once. Mixed into the
 * day's board it was thirty rows that all read "yet to start" and hid the four
 * things that were actually late.
 *
 * So: unwritten briefs live here and nowhere else. The moment one has gone to
 * the client, it becomes a thing that is waiting on somebody — and that is
 * Today's Tasks' job, so it appears there too.
 */
import "server-only";
import { query, queryOne, execute } from "./db";
import { getGroupsForClient } from "./whatsapp-approvals";
import { sendTextToGroup } from "./whatsapp-service-client";
import { fmtDate } from "./utils";

export type ContentRow = {
  id: number;
  client_id: number;
  company_name: string;
  contact_person: string | null;
  title: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  status: string;
  due_date: string | null;
  description: string | null;
  assigned_to: number | null;
  assignee_name: string | null;
  /** 0 only where the client has the sign-off switched off. Null pre-migration. */
  content_approval: number | null;
  /** When the brief last went out, so a re-send is a deliberate one. */
  content_sent_at: string | null;
};

/** One client's briefs, which is how the work is actually done. */
export type ContentGroup = {
  clientId: number;
  companyName: string;
  contactPerson: string | null;
  /** False when nothing can be sent to WhatsApp, so the button can say why. */
  hasGroup: boolean;
  approvesContent: boolean;
  toWrite: ContentRow[];
  ready: ContentRow[];
  withClient: ContentRow[];
};

/**
 * Every brief that is not yet signed off, newest client first.
 *
 * `pending` covers both "nothing written" and "written but not sent" — the
 * status does not distinguish them, the description does, and the board splits
 * on that rather than inventing a status for it.
 */
export async function getContentBoard(
  crmClientIds: number[] | null,
  hasContentApproval: boolean,
  hasSentAt: boolean
): Promise<ContentGroup[]> {
  const scope = crmClientIds ? ` AND d.client_id IN (${crmClientIds.join(",") || "0"})` : "";
  const rows = await query<ContentRow>(
    `SELECT d.id, d.client_id, c.company_name, c.contact_person, d.title,
            d.service, d.video_type, d.content_category, d.status, d.due_date,
            d.description, d.assigned_to, u.name AS assignee_name,
            ${hasContentApproval ? "c.content_approval" : "NULL AS content_approval"},
            ${hasSentAt ? "d.content_sent_at" : "NULL AS content_sent_at"}
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN users u ON u.id = d.assigned_to
      WHERE d.status IN ('pending','content_review')${scope}
      ORDER BY c.company_name ASC, d.due_date IS NULL, d.due_date ASC, d.id ASC`
  );
  if (rows.length === 0) return [];

  // One lookup per client rather than per row: a month for one client is
  // thirty rows and one group.
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const groups = new Map<number, boolean>();
  await Promise.all(
    clientIds.map(async (id) => groups.set(id, (await getGroupsForClient(id)).length > 0))
  );

  const out = new Map<number, ContentGroup>();
  for (const r of rows) {
    let g = out.get(r.client_id);
    if (!g) {
      g = {
        clientId: r.client_id,
        companyName: r.company_name,
        contactPerson: r.contact_person,
        hasGroup: groups.get(r.client_id) ?? false,
        approvesContent: r.content_approval === null || Number(r.content_approval) === 1,
        toWrite: [],
        ready: [],
        withClient: [],
      };
      out.set(r.client_id, g);
    }
    if (r.status === "content_review") g.withClient.push(r);
    else if ((r.description ?? "").trim()) g.ready.push(r);
    else g.toWrite.push(r);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/*  What the client reads                                             */
/* ------------------------------------------------------------------ */

/**
 * WhatsApp takes 4096 characters in one text message. A month of briefs is
 * comfortably more than that, so a batch is split across messages rather than
 * truncated — a client must never approve copy they were not shown.
 */
const MAX_CHARS = 3500;

export type ContentPiece = { title: string; dueDate: string | null; body: string };

/**
 * The messages one client gets, in the order they should read them.
 *
 * A single brief is sent as itself — no numbering, no "1 of 1", because a
 * client reading one piece of copy does not need a table of contents. A batch
 * is numbered, so "change number 3" is a thing they can say.
 *
 * The ask is always the last message, never bundled with the copy: mixed
 * together, a client checking their own words has to find where ours stopped.
 */
export function buildContentMessages(
  companyName: string,
  contactPerson: string | null,
  pieces: ContentPiece[]
): string[] {
  if (pieces.length === 0) return [];
  const greeting = contactPerson?.trim() ? `Hello ${contactPerson.trim()},` : `Hello ${companyName},`;
  const single = pieces.length === 1;

  const header = single
    ? `📝 *Content for your approval*\n\n${greeting}\n\nHere is the content we have planned. Please have a look whenever you have a moment.`
    : `📝 *Content for your approval*\n\n${greeting}\n\nHere is the content we have planned — ${pieces.length} pieces in all. Please have a look whenever you have a moment.`;

  const block = (p: ContentPiece, i: number) => {
    const n = single ? "" : `*${i + 1}. `;
    const close = single ? "" : "*";
    const due = p.dueDate ? ` _(${fmtDate(p.dueDate)})_` : "";
    return single
      ? `*${p.title}*${due}\n\n${p.body.trim()}`
      : `${n}${p.title}${close}${due}\n${p.body.trim()}`;
  };

  const ask =
    `Could you please review and reply:\n\n` +
    `✅ *OK* to approve\n` +
    `📝 *CHANGE* — and tell us what you would like adjusted` +
    (single ? "" : ", with the number") +
    `\n\n_A voice note works too._\n\nThank you! 🙏`;

  /*
   * Packed rather than one message per piece. Thirty separate messages is a
   * notification storm; one long one is unreadable. So: fill up to the limit,
   * then start another — and a single brief longer than the limit still goes
   * whole, in a message of its own, because cutting it is the one thing that
   * must not happen.
   */
  const out: string[] = [];
  let buf = header;
  pieces.forEach((p, i) => {
    const chunk = block(p, i);
    if (buf.length + chunk.length + 2 > MAX_CHARS) {
      out.push(buf);
      buf = chunk;
    } else {
      buf = `${buf}\n\n${chunk}`;
    }
  });
  out.push(buf);
  out.push(ask);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Sending                                                            */
/* ------------------------------------------------------------------ */

export type ContentSendResult =
  | { ok: true; sent: number; messages: number; clientName: string }
  | { ok: false; error: string };

/**
 * Put a client's written briefs in front of them on WhatsApp.
 *
 * Deliberately not `applyStatus` in a loop. That path emails the client and
 * writes a portal notification per task, which for a month's batch is fifteen
 * emails about one message — and it would send fifteen separate WhatsApp
 * threads too. This sends once and moves all of them together.
 */
export async function sendContentForApproval(
  clientId: number,
  deliverableIds: number[],
  actorId: number,
  hasSentAt: boolean
): Promise<ContentSendResult> {
  if (deliverableIds.length === 0) return { ok: false, error: "Nothing selected to send." };
  const ids = deliverableIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: false, error: "Nothing selected to send." };

  const client = await queryOne<{ company_name: string; contact_person: string | null }>(
    "SELECT company_name, contact_person FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return { ok: false, error: "Client not found." };

  const rows = await query<{ id: number; title: string; due_date: string | null; description: string | null }>(
    `SELECT id, title, due_date, description FROM deliverables
      WHERE client_id = ? AND id IN (${ids.join(",")}) AND status = 'pending'
      ORDER BY due_date IS NULL, due_date ASC, id ASC`,
    [clientId]
  );
  const written = rows.filter((r) => (r.description ?? "").trim());
  if (written.length === 0) {
    return { ok: false, error: "None of these has content written yet." };
  }

  const groups = await getGroupsForClient(clientId);
  const group = groups[0];
  if (!group) {
    return {
      ok: false,
      error: `${client.company_name} has no WhatsApp group linked. Add one under Settings → WhatsApp.`,
    };
  }

  const messages = buildContentMessages(
    client.company_name,
    client.contact_person,
    written.map((r) => ({ title: r.title, dueDate: r.due_date, body: r.description ?? "" }))
  );

  /*
   * Sent before the status moves, and the status only moves on what went.
   *
   * The other order — mark them sent, then send — leaves a client's whole
   * month sitting in "waiting for their approval" when WhatsApp was simply
   * down, and nobody chases an approval they believe was already requested.
   */
  for (const [i, text] of messages.entries()) {
    const sent = await sendTextToGroup(group.group_id, text);
    if (!sent.ok) {
      // Part of a batch may already be in the group. Say so rather than
      // pretending nothing happened — the recovery is different.
      return {
        ok: false,
        error:
          i === 0
            ? `WhatsApp did not accept the message: ${sent.error}`
            : `${i} of ${messages.length} messages went through, then WhatsApp stopped: ${sent.error}. Check the group before sending again.`,
      };
    }
  }

  const sentIds = written.map((r) => r.id);
  await execute(
    `UPDATE deliverables
        SET status = 'content_review', approval_status = 'pending', reject_reason = NULL
            ${hasSentAt ? ", content_sent_at = NOW()" : ""}
      WHERE id IN (${sentIds.join(",")})`
  );
  for (const id of sentIds) {
    await execute(
      "INSERT INTO approvals (deliverable_id, client_id, action, comment, actioned_by) VALUES (?,?,?,?,?)",
      [id, clientId, "content_review", "Content sent to the client's WhatsApp group.", actorId]
    );
  }

  return {
    ok: true,
    sent: sentIds.length,
    messages: messages.length,
    clientName: client.company_name,
  };
}
