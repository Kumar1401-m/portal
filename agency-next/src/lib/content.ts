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
import { callJSON } from "./ai";

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
  /**
   * What this content is about — a property, a project, a launch.
   *
   * The `campaign` column, which is what it has always been; "property" is
   * what it is called on screen because that is what it holds for the clients
   * who needed the grouping. A client's month is not one undifferentiated
   * list: it is four posts about this flat and six about that one, and the
   * client reads and approves them that way.
   */
  campaign: string | null;
  /** 0 only where the client has the sign-off switched off. Null pre-migration. */
  content_approval: number | null;
  /** When the brief last went out, so a re-send is a deliberate one. */
  content_sent_at: string | null;
};

/** One property's content, within one client. */
export type PropertyGroup = {
  /** The empty string is the real, unnamed group — not a missing one. */
  name: string;
  toWrite: ContentRow[];
  ready: ContentRow[];
  withClient: ContentRow[];
};

/** One client's briefs, which is how the work is actually done. */
export type ContentGroup = {
  clientId: number;
  companyName: string;
  contactPerson: string | null;
  /** False when nothing can be sent to WhatsApp, so the button can say why. */
  hasGroup: boolean;
  approvesContent: boolean;
  properties: PropertyGroup[];
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
 *
 * Churned clients are excluded, the same rule every other board follows via
 * `buildWhere`. A client who left owes nobody a brief, and their unwritten
 * month would otherwise sit on this desk for ever — growing, never actionable,
 * and counted in the heading as work outstanding.
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
            d.description, d.assigned_to, u.name AS assignee_name, d.campaign,
            ${hasContentApproval ? "c.content_approval" : "NULL AS content_approval"},
            ${hasSentAt ? "d.content_sent_at" : "NULL AS content_sent_at"}
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN users u ON u.id = d.assigned_to
      WHERE d.status IN ('pending','content_review')
        AND c.status != 'churned'${scope}
      ORDER BY c.company_name ASC, d.campaign IS NULL, d.campaign ASC,
               d.due_date IS NULL, d.due_date ASC, d.id ASC`
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
  const byProperty = new Map<string, PropertyGroup>();

  for (const r of rows) {
    let g = out.get(r.client_id);
    if (!g) {
      g = {
        clientId: r.client_id,
        companyName: r.company_name,
        contactPerson: r.contact_person,
        hasGroup: groups.get(r.client_id) ?? false,
        approvesContent: r.content_approval === null || Number(r.content_approval) === 1,
        properties: [],
        toWrite: [],
        ready: [],
        withClient: [],
      };
      out.set(r.client_id, g);
    }

    // Two views of the same rows: the client's whole month, and the month cut
    // by property. Both are needed — "send everything" and "send this one" are
    // both things people do, and neither is a special case of the other.
    const name = (r.campaign ?? "").trim();
    const key = `${r.client_id}::${name}`;
    let p = byProperty.get(key);
    if (!p) {
      p = { name, toWrite: [], ready: [], withClient: [] };
      byProperty.set(key, p);
      g.properties.push(p);
    }

    const bucket =
      r.status === "content_review" ? "withClient" : (r.description ?? "").trim() ? "ready" : "toWrite";
    g[bucket].push(r);
    p[bucket].push(r);
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

export type ContentPiece = {
  title: string;
  dueDate: string | null;
  body: string;
  /** The property this is about, or "" when it belongs to no particular one. */
  property?: string | null;
};

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

  /*
   * Named by what it is about, when everything in the batch is about one thing.
   *
   * A client with six properties does not want "here is your content" — they
   * want to know which one they are reading about before they read it, and to
   * be able to answer about that one. When a batch spans several, the headings
   * below do the same job inside the message.
   */
  const properties = [...new Set(pieces.map((p) => (p.property ?? "").trim()).filter(Boolean))];
  const onlyProperty = properties.length === 1 && pieces.every((p) => (p.property ?? "").trim())
    ? properties[0]
    : null;

  const title = onlyProperty
    ? `📝 *Content for your approval — ${onlyProperty}*`
    : `📝 *Content for your approval*`;
  const header = single
    ? `${title}\n\n${greeting}\n\nHere is the content we have planned. Please have a look whenever you have a moment.`
    : `${title}\n\n${greeting}\n\nHere is the content we have planned — ${pieces.length} pieces in all. Please have a look whenever you have a moment.`;

  const block = (p: ContentPiece, i: number) => {
    const n = single ? "" : `*${i + 1}. `;
    const close = single ? "" : "*";
    const due = p.dueDate ? ` _(${fmtDate(p.dueDate)})_` : "";
    // Only where it adds something: repeating the property on every line of a
    // batch that is entirely about that property is noise.
    const where = !onlyProperty && (p.property ?? "").trim() ? ` · ${(p.property ?? "").trim()}` : "";
    return single
      ? `*${p.title}*${due}\n\n${p.body.trim()}`
      : `${n}${p.title}${close}${where}${due}\n${p.body.trim()}`;
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

  const rows = await query<{
    id: number;
    title: string;
    due_date: string | null;
    description: string | null;
    campaign: string | null;
  }>(
    `SELECT id, title, due_date, description, campaign FROM deliverables
      WHERE client_id = ? AND id IN (${ids.join(",")}) AND status = 'pending'
      ORDER BY campaign IS NULL, campaign ASC, due_date IS NULL, due_date ASC, id ASC`,
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
    written.map((r) => ({
      title: r.title,
      dueDate: r.due_date,
      body: r.description ?? "",
      property: r.campaign,
    }))
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

/* ------------------------------------------------------------------ */
/*  Naming the piece                                                   */
/* ------------------------------------------------------------------ */

/**
 * A title the month generator made up, rather than one anybody chose.
 *
 * `generateMonthTasks` names a month "Video 1..12" and "Poster 1..4" — it has
 * to call them something before anyone has written a word. The numbers are
 * doing real work while the month is being planned, and none at all once the
 * copy exists: a board of "Video 6, Video 7, Video 8" tells you nothing about
 * what is in any of them.
 */
export const isPlaceholderTitle = (title: string): boolean =>
  /^(video|poster|reel|post)\s*\d+$/i.test(String(title || "").trim());

/**
 * A short title for a piece, from the copy that was just written for it.
 *
 * Only ever replaces a placeholder — a title somebody typed is theirs, and
 * silently rewriting it would be the portal editing a person's work. Returns
 * null when there is no model, when the copy is too thin to name, or when the
 * model answers with something unusable; the caller keeps the old title in
 * every one of those cases rather than treating any of them as a failure.
 */
export async function suggestTitle(
  body: string,
  companyName?: string | null
): Promise<string | null> {
  const copy = String(body || "").trim();
  // Under a few words there is nothing to summarise, and a "title" derived
  // from three of them is just those three words again.
  if (copy.length < 25) return null;

  const { data } = await callJSON(
    [
      "You name social-media posts for a marketing agency's internal board.",
      "Given the copy for one post, reply with JSON: {\"title\":\"...\"}",
      "The title is read by the team, not the client. Make it say what the post is about.",
      "Three to six words. No quotes, no emoji, no hashtags, no full stop.",
      "Use the language of the copy's subject, but write the title in English.",
    ].join(" "),
    `${companyName ? `Client: ${companyName}\n` : ""}Copy:\n${copy.slice(0, 1500)}`
  );

  const raw = typeof data?.title === "string" ? data.title.trim() : "";
  if (!raw) return null;

  // Trimmed rather than trusted: models add quotes and trailing stops however
  // firmly they are asked not to, and a stray one ends up on the board.
  const title = raw.replace(/^["'“”\s]+|["'“”.\s]+$/g, "").slice(0, 120);
  // A model that echoes the placeholder back has told us nothing.
  if (!title || isPlaceholderTitle(title)) return null;
  return title;
}
