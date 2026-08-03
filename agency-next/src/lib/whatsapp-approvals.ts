/**
 * WhatsApp video approvals — the portal's half.
 *
 * The client approves finished video in their own WhatsApp group by replying
 * "APPROVE V245" or "CHANGE V245 <notes>". A separate Express service drives
 * WhatsApp Web; this module is the system of record it reports into.
 *
 * Two rules shape everything here:
 *
 *   Idempotency. WhatsApp redelivers messages after a reconnect, so the same
 *   "APPROVE V245" arrives two or three times. Every write is keyed on the
 *   WhatsApp message id, and a replay is a no-op rather than a second approval.
 *
 *   The transcript is kept whole. Every group message is stored, command or
 *   not — "the client says they approved it" is a dispute settled by the
 *   transcript, not by the parsed result.
 */
import "server-only";
import { query, queryOne, execute, transaction, hasColumn } from "./db";
import { notifyAdmins } from "./notify";
import { resolveVideoUrl } from "./storage";

/** How the WhatsApp conversation for one video is going. */
export type WaStatus =
  | "not_sent"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "viewed"
  | "approved"
  | "changes_requested"
  | "rejected"
  | "failed";

/** Whether the schema for this feature has been applied. */
export async function approvalsReady(): Promise<boolean> {
  return hasColumn("deliverables", "wa_status");
}

/* ------------------------------- Video codes ------------------------------- */

/**
 * The short handle a client types into WhatsApp: V245.
 *
 * Deliberately not the primary key. A client typing "APPROVE 1043" into a
 * group is one fat finger away from approving someone else's video, whereas a
 * code that is only issued to videos actually sent for approval keeps the
 * namespace small and the mistakes visible.
 *
 * Allocated inside a transaction with a row lock on the max: two admins
 * pressing "Send for approval" at the same instant would otherwise both read
 * 244 and both write V245, and the unique index would fail the second one.
 */
export async function ensureVideoCode(deliverableId: number): Promise<string> {
  const existing = await queryOne<{ video_code: string | null }>(
    "SELECT video_code FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (existing?.video_code) return existing.video_code;

  return transaction(async (conn) => {
    // Re-read under the lock: another request may have allocated one between
    // the check above and here.
    const [rows] = await conn.execute(
      "SELECT video_code FROM deliverables WHERE id = ? FOR UPDATE",
      [deliverableId]
    );
    const current = (rows as { video_code: string | null }[])[0];
    if (current?.video_code) return current.video_code;

    const [maxRows] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(video_code, 2) AS UNSIGNED)), 100) AS n
         FROM deliverables
        WHERE video_code REGEXP '^V[0-9]+$'`
    );
    const next = Number((maxRows as { n: number }[])[0]?.n ?? 100) + 1;
    const code = `V${next}`;

    await conn.execute("UPDATE deliverables SET video_code = ? WHERE id = ?", [
      code,
      deliverableId,
    ]);
    return code;
  });
}

/** Find a deliverable by the code a client typed. Case-insensitive. */
export async function findByVideoCode(code: string): Promise<{
  id: number;
  client_id: number;
  title: string;
  video_code: string;
  wa_status: string;
  wa_group_id: string | null;
} | null> {
  if (!/^[A-Za-z]{1,3}\d{1,8}$/.test(code.trim())) return null;
  return queryOne(
    `SELECT id, client_id, title, video_code, wa_status, wa_group_id
       FROM deliverables WHERE UPPER(video_code) = UPPER(?)`,
    [code.trim()]
  );
}

/* --------------------------------- Groups --------------------------------- */

export type WhatsAppGroup = {
  id: number;
  client_id: number;
  group_id: string;
  group_name: string | null;
  is_default: number;
  is_active: number;
  company_name?: string;
};

export async function getGroupsForClient(clientId: number): Promise<WhatsAppGroup[]> {
  if (!(await approvalsReady())) return [];
  return query<WhatsAppGroup>(
    `SELECT * FROM whatsapp_groups WHERE client_id = ? AND is_active = 1
      ORDER BY is_default DESC, id`,
    [clientId]
  );
}

/** Every mapping, for the settings screen. */
export async function getAllGroups(): Promise<WhatsAppGroup[]> {
  if (!(await approvalsReady())) return [];
  return query<WhatsAppGroup>(
    `SELECT g.*, c.company_name FROM whatsapp_groups g
       JOIN clients c ON c.id = g.client_id
      ORDER BY c.company_name, g.is_default DESC`
  );
}

/** Which client owns a group — how an inbound reply is attributed. */
export async function clientForGroup(groupId: string): Promise<number | null> {
  if (!(await approvalsReady())) return null;
  const row = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM whatsapp_groups WHERE group_id = ? AND is_active = 1",
    [groupId]
  );
  return row?.client_id ?? null;
}

export async function linkGroup(
  clientId: number,
  groupId: string,
  groupName: string | null,
  isDefault = true
): Promise<void> {
  // One group maps to exactly one client — the unique index enforces it, and
  // the upsert re-points an existing mapping rather than failing.
  await execute(
    `INSERT INTO whatsapp_groups (client_id, group_id, group_name, is_default)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE
       client_id = VALUES(client_id),
       group_name = VALUES(group_name),
       is_default = VALUES(is_default),
       is_active = 1`,
    [clientId, groupId, groupName, isDefault ? 1 : 0]
  );
}

export async function unlinkGroup(groupId: string): Promise<void> {
  await execute("UPDATE whatsapp_groups SET is_active = 0 WHERE group_id = ?", [groupId]);
}

/* ------------------------------ Sending state ------------------------------ */

export type SendableVideo = {
  deliverableId: number;
  videoCode: string;
  clientId: number;
  clientName: string;
  title: string;
  groupId: string;
  videoUrl: string;
  caption: string;
};

/**
 * Everything the WhatsApp service needs to send one video, or a reason it
 * can't. Returning the reason rather than throwing lets the caller show the
 * admin something actionable instead of a stack trace.
 */
export async function prepareSend(
  deliverableId: number
): Promise<{ ok: true; video: SendableVideo } | { ok: false; error: string }> {
  if (!(await approvalsReady())) {
    return { ok: false, error: "The WhatsApp approval tables are not set up yet." };
  }

  const d = await queryOne<{
    id: number;
    client_id: number;
    title: string;
    company_name: string;
    cloud_video_url: string | null;
    cloud_video_key: string | null;
    edited_link: string | null;
    wa_status: string;
    video_code: string | null;
  }>(
    `SELECT d.id, d.client_id, d.title, c.company_name,
            d.cloud_video_url, d.cloud_video_key, d.edited_link,
            d.wa_status, d.video_code
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found." };

  if (d.wa_status === "approved") {
    return { ok: false, error: "This video has already been approved on WhatsApp." };
  }

  const groups = await getGroupsForClient(d.client_id);
  const group = groups[0];
  if (!group) {
    return {
      ok: false,
      error: `${d.company_name} has no WhatsApp group linked. Add one under Settings → WhatsApp.`,
    };
  }

  // WhatsApp fetches the bytes itself, so this must be a real, reachable file.
  // A signed R2 link is fine; a Drive share link serves an HTML page.
  const videoUrl =
    (await resolveVideoUrl(d.cloud_video_key, d.cloud_video_url, 6 * 60 * 60)) || d.edited_link;
  if (!videoUrl) {
    return {
      ok: false,
      error: "This task has no uploaded video. Upload the finished file before sending.",
    };
  }

  const videoCode = await ensureVideoCode(deliverableId);

  return {
    ok: true,
    video: {
      deliverableId: d.id,
      videoCode,
      clientId: d.client_id,
      clientName: d.company_name,
      title: d.title,
      groupId: group.group_id,
      videoUrl,
      caption: buildCaption(videoCode, d.title),
    },
  };
}

/**
 * The caption the client sees.
 *
 * The reply syntax shown here must stay identical to what the service's parser
 * accepts — if they drift, clients follow instructions that no longer work.
 */
export function buildCaption(videoCode: string, title?: string | null): string {
  return (
    `📹 *Video Ready*\n\n` +
    (title ? `_${title}_\n\n` : "") +
    `Video ID: *${videoCode}*\n\n` +
    `Please review and reply:\n\n` +
    `✅ *APPROVE ${videoCode}*\n` +
    `📝 *CHANGE ${videoCode}* (then your notes)\n\n` +
    `_You can also reply directly to this message._`
  );
}

/** Mark a video as handed to the WhatsApp service. */
export async function markQueued(deliverableId: number, groupId: string): Promise<void> {
  await execute(
    `UPDATE deliverables
        SET wa_status = 'queued', wa_group_id = ?, wa_last_error = NULL,
            wa_send_attempts = wa_send_attempts + 1
      WHERE id = ?`,
    [groupId, deliverableId]
  );
}

/** Record the outcome of a send attempt, from the service's callback. */
export async function recordSendStatus(input: {
  deliverableId?: number | null;
  videoCode?: string | null;
  groupId?: string | null;
  attemptNo?: number;
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed";
  waMessageId?: string | null;
  mediaBytes?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  if (!(await approvalsReady())) return;

  /*
   * A delivery or read receipt arrives minutes later carrying ONLY the
   * WhatsApp message id, so the deliverable has to be recovered from it.
   *
   * Three sources, in order of reliability. The send-log fallback matters:
   * `deliverables.wa_message_id` is only written when the "sent" update is
   * allowed through, and that update deliberately refuses to touch a video the
   * client has already answered. Without the log lookup, a receipt for such a
   * video would be stored as an orphan row attributable to nothing.
   */
  let deliverableId = input.deliverableId ?? null;
  if (!deliverableId && input.waMessageId) {
    const row = await queryOne<{ id: number }>(
      "SELECT id FROM deliverables WHERE wa_message_id = ? LIMIT 1",
      [input.waMessageId]
    );
    deliverableId = row?.id ?? null;
  }
  if (!deliverableId && input.waMessageId) {
    const logged = await queryOne<{ deliverable_id: number | null }>(
      `SELECT deliverable_id FROM whatsapp_send_log
        WHERE wa_message_id = ? AND deliverable_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [input.waMessageId]
    );
    deliverableId = logged?.deliverable_id ?? null;
  }
  if (!deliverableId && input.videoCode) {
    const d = await findByVideoCode(input.videoCode);
    deliverableId = d?.id ?? null;
  }

  await execute(
    `INSERT INTO whatsapp_send_log
       (deliverable_id, video_code, group_id, attempt_no, status, wa_message_id,
        media_bytes, duration_ms, error_code, error_message)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      deliverableId,
      input.videoCode ?? null,
      input.groupId ?? null,
      input.attemptNo ?? 1,
      input.status,
      input.waMessageId ?? null,
      input.mediaBytes ?? null,
      input.durationMs ?? null,
      input.errorCode ?? null,
      input.errorMessage ? String(input.errorMessage).slice(0, 2000) : null,
    ]
  );

  if (!deliverableId) return;

  // The deliverable carries only the current state; the log above is the history.
  if (input.status === "sent") {
    await execute(
      `UPDATE deliverables
          SET wa_status = 'sent', wa_message_id = ?, wa_sent_at = NOW(), wa_last_error = NULL
        WHERE id = ? AND wa_status NOT IN ('approved','changes_requested','rejected')`,
      [input.waMessageId ?? null, deliverableId]
    );
  } else if (input.status === "delivered") {
    await execute(
      `UPDATE deliverables SET wa_status = 'delivered', wa_delivered_at = COALESCE(wa_delivered_at, NOW())
        WHERE id = ? AND wa_status IN ('sent','queued','sending')`,
      [deliverableId]
    );
  } else if (input.status === "read") {
    // "Read" is the closest WhatsApp gets to "the client has seen it", which
    // is what the client-facing timeline calls Viewed.
    await execute(
      `UPDATE deliverables SET wa_status = 'viewed', wa_viewed_at = COALESCE(wa_viewed_at, NOW())
        WHERE id = ? AND wa_status IN ('sent','delivered','queued','sending')`,
      [deliverableId]
    );
  } else if (input.status === "failed") {
    await execute(
      `UPDATE deliverables SET wa_status = 'failed', wa_last_error = ?
        WHERE id = ? AND wa_status NOT IN ('approved','changes_requested','rejected')`,
      [input.errorMessage ? String(input.errorMessage).slice(0, 2000) : "Send failed", deliverableId]
    );
  }
}

/* -------------------------------- Approvals -------------------------------- */

export type ApprovalInput = {
  videoCode: string;
  command: "approve" | "change" | "reject";
  approvedBy?: string | null;
  approvedNumber?: string | null;
  message?: string | null;
  comment?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  waMessageId?: string | null;
  time?: string | null;
};

export type ApprovalResult = {
  ok: boolean;
  error?: string;
  alreadyRecorded?: boolean;
  deliverableId?: number;
  title?: string;
  clientId?: number;
  status?: string;
};

/** How a WhatsApp verdict maps onto the portal's own workflow status. */
const PORTAL_STATUS: Record<ApprovalInput["command"], string> = {
  approve: "approved",
  change: "changes_requested",
  reject: "rejected",
};

const WA_STATUS: Record<ApprovalInput["command"], WaStatus> = {
  approve: "approved",
  change: "changes_requested",
  reject: "rejected",
};

/**
 * Record a client's verdict.
 *
 * Idempotent on `wa_message_id`: WhatsApp replays messages after a reconnect,
 * and a replayed approval must not notify the team twice or overwrite a
 * later, deliberate change of mind.
 */
export async function recordApproval(input: ApprovalInput): Promise<ApprovalResult> {
  if (!(await approvalsReady())) {
    return { ok: false, error: "The WhatsApp approval tables are not set up yet." };
  }

  const d = await findByVideoCode(input.videoCode);
  if (!d) {
    return { ok: false, error: `No video with the code ${input.videoCode}.` };
  }

  // A reply must come from the group the video was sent to. Without this, a
  // client in one group could approve another client's video simply by typing
  // its code.
  if (input.groupId) {
    const owner = await clientForGroup(input.groupId);
    if (owner !== null && owner !== d.client_id) {
      return {
        ok: false,
        error: `${input.videoCode} does not belong to this WhatsApp group.`,
      };
    }
  }

  /*
   * Replay detection.
   *
   * Keyed on the deliverable's own `wa_approval_message_id`, NOT on the
   * transcript. The transcript is written by a separate best-effort call that
   * the service makes *before* this one, so checking it would treat the very
   * first approval as a replay — and would miss genuine replays whenever that
   * write had failed.
   */
  if (input.waMessageId) {
    const seen = await queryOne<{ id: number }>(
      "SELECT id FROM deliverables WHERE id = ? AND wa_approval_message_id = ?",
      [d.id, input.waMessageId]
    );
    if (seen) {
      return {
        ok: true,
        alreadyRecorded: true,
        deliverableId: d.id,
        title: d.title,
        clientId: d.client_id,
        status: PORTAL_STATUS[input.command],
      };
    }
  }

  const respondedAt = input.time ? new Date(input.time) : new Date();
  const mysqlTime = Number.isNaN(respondedAt.getTime())
    ? null
    : respondedAt.toISOString().slice(0, 19).replace("T", " ");

  await execute(
    `UPDATE deliverables
        SET wa_status = ?,
            status = ?,
            approval_status = ?,
            wa_approved_by = ?,
            wa_approved_phone = ?,
            wa_comment = ?,
            wa_responded_at = COALESCE(?, NOW()),
            wa_approval_message_id = ?,
            reject_reason = IF(? IN ('changes_requested','rejected'), ?, reject_reason)
      WHERE id = ?`,
    [
      WA_STATUS[input.command],
      PORTAL_STATUS[input.command],
      input.command === "approve" ? "approved" : input.command === "change" ? "changes_requested" : "rejected",
      input.approvedBy ?? null,
      input.approvedNumber ?? null,
      input.comment ?? null,
      mysqlTime,
      input.waMessageId ?? null,
      PORTAL_STATUS[input.command],
      input.comment ?? null,
      d.id,
    ]
  );

  await execute(
    `INSERT INTO activity_logs (actor_name, action, entity_type, entity_id, description, meta_json)
     VALUES (?, ?, 'deliverable', ?, ?, ?)`,
    [
      input.approvedBy || "WhatsApp",
      `whatsapp_${input.command}`,
      d.id,
      input.command === "approve"
        ? `"${d.title}" approved on WhatsApp`
        : input.command === "change"
          ? `Changes requested for "${d.title}" on WhatsApp`
          : `"${d.title}" rejected on WhatsApp`,
      JSON.stringify({
        video_code: d.video_code,
        group_id: input.groupId ?? null,
        phone: input.approvedNumber ?? null,
        comment: input.comment ?? null,
      }),
    ]
  );

  const who = input.approvedBy || "The client";
  await notifyAdmins(
    "general",
    input.command === "approve"
      ? `${d.video_code} approved`
      : input.command === "change"
        ? `${d.video_code}: changes requested`
        : `${d.video_code} rejected`,
    input.command === "change" && input.comment
      ? `${who} asked for changes to "${d.title}": ${input.comment.slice(0, 200)}`
      : `${who} ${input.command === "approve" ? "approved" : "rejected"} "${d.title}" on WhatsApp.`,
    `/deliverables/${d.id}`
  );

  return {
    ok: true,
    deliverableId: d.id,
    title: d.title,
    clientId: d.client_id,
    status: PORTAL_STATUS[input.command],
  };
}

/* ------------------------------ Message log ------------------------------- */

export async function logIncomingMessage(input: {
  waMessageId?: string | null;
  groupId: string;
  groupName?: string | null;
  senderName?: string | null;
  senderNumber?: string | null;
  message?: string | null;
  videoCode?: string | null;
  parsedCommand?: string | null;
  direction?: "in" | "out";
  time?: string | null;
}): Promise<void> {
  if (!(await approvalsReady())) return;

  const clientId = await clientForGroup(input.groupId);
  const deliverable = input.videoCode ? await findByVideoCode(input.videoCode) : null;
  const when = input.time ? new Date(input.time) : new Date();
  const mysqlTime = Number.isNaN(when.getTime())
    ? new Date().toISOString().slice(0, 19).replace("T", " ")
    : when.toISOString().slice(0, 19).replace("T", " ");

  await execute(
    `INSERT INTO whatsapp_messages
       (wa_message_id, group_id, group_name, client_id, deliverable_id, video_code,
        sender_name, sender_number, direction, message, parsed_command, message_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       parsed_command = VALUES(parsed_command),
       video_code = COALESCE(VALUES(video_code), video_code),
       deliverable_id = COALESCE(VALUES(deliverable_id), deliverable_id)`,
    [
      input.waMessageId ?? null,
      input.groupId,
      input.groupName ?? null,
      clientId,
      deliverable?.id ?? null,
      input.videoCode ?? null,
      input.senderName ?? null,
      input.senderNumber ?? null,
      input.direction ?? "in",
      input.message ? String(input.message).slice(0, 4000) : null,
      input.parsedCommand ?? null,
      mysqlTime,
    ]
  );
}

export type MessageRow = {
  id: number;
  group_id: string;
  group_name: string | null;
  sender_name: string | null;
  sender_number: string | null;
  message: string | null;
  video_code: string | null;
  parsed_command: string | null;
  direction: string;
  message_time: string;
  company_name: string | null;
};

export async function getMessages(limit = 100, clientId?: number): Promise<MessageRow[]> {
  if (!(await approvalsReady())) return [];
  return query<MessageRow>(
    `SELECT m.*, c.company_name FROM whatsapp_messages m
       LEFT JOIN clients c ON c.id = m.client_id
      ${clientId ? "WHERE m.client_id = ?" : ""}
      ORDER BY m.message_time DESC, m.id DESC
      LIMIT ${Number(limit) || 100}`,
    clientId ? [clientId] : []
  );
}

/* -------------------------------- Dashboard -------------------------------- */

export type ApprovalCounts = {
  pending: number;
  approved: number;
  changesRequested: number;
  rejected: number;
  readyToPost: number;
  failed: number;
};

/**
 * The dashboard's cards.
 *
 * "Pending" means genuinely awaiting the client — sent and not yet answered.
 * A video that failed to send is NOT pending: nobody is waiting on the client,
 * the agency has a problem to fix, and conflating the two hides it.
 */
export async function getApprovalCounts(clientIds?: number[] | null): Promise<ApprovalCounts> {
  if (!(await approvalsReady())) {
    return { pending: 0, approved: 0, changesRequested: 0, rejected: 0, readyToPost: 0, failed: 0 };
  }
  const scope =
    clientIds && clientIds.length
      ? `AND d.client_id IN (${clientIds.map(() => "?").join(",")})`
      : clientIds && clientIds.length === 0
        ? "AND 1=0"
        : "";

  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(d.wa_status IN ('queued','sending','sent','delivered','viewed')),0) AS pending,
       COALESCE(SUM(d.wa_status = 'approved'),0)          AS approved,
       COALESCE(SUM(d.wa_status = 'changes_requested'),0) AS changes_requested,
       COALESCE(SUM(d.wa_status = 'rejected'),0)          AS rejected,
       COALESCE(SUM(d.wa_status = 'failed'),0)            AS failed,
       COALESCE(SUM(d.wa_status = 'approved' AND d.status <> 'posted'),0) AS ready_to_post
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE c.status <> 'churned' ${scope}`,
    clientIds && clientIds.length ? clientIds : []
  );

  const n = (v: unknown) => Number(v ?? 0);
  return {
    pending: n(row?.pending),
    approved: n(row?.approved),
    changesRequested: n(row?.changes_requested),
    rejected: n(row?.rejected),
    readyToPost: n(row?.ready_to_post),
    failed: n(row?.failed),
  };
}

export type ApprovalRow = {
  id: number;
  video_code: string | null;
  title: string;
  company_name: string;
  client_id: number;
  wa_status: string;
  wa_group_id: string | null;
  wa_sent_at: string | null;
  wa_viewed_at: string | null;
  wa_responded_at: string | null;
  wa_approved_by: string | null;
  wa_comment: string | null;
  wa_last_error: string | null;
  status: string;
};

export async function getApprovalBoard(
  clientIds?: number[] | null,
  limit = 100
): Promise<ApprovalRow[]> {
  if (!(await approvalsReady())) return [];
  const scope =
    clientIds && clientIds.length
      ? `AND d.client_id IN (${clientIds.map(() => "?").join(",")})`
      : clientIds && clientIds.length === 0
        ? "AND 1=0"
        : "";

  return query<ApprovalRow>(
    `SELECT d.id, d.video_code, d.title, c.company_name, d.client_id,
            d.wa_status, d.wa_group_id, d.wa_sent_at, d.wa_viewed_at,
            d.wa_responded_at, d.wa_approved_by, d.wa_comment, d.wa_last_error, d.status
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned' AND d.wa_status <> 'not_sent' ${scope}
      ORDER BY COALESCE(d.wa_responded_at, d.wa_sent_at, d.updated_at) DESC
      LIMIT ${Number(limit) || 100}`,
    clientIds && clientIds.length ? clientIds : []
  );
}

/* --------------------------------- Session -------------------------------- */

export type SessionHealth = {
  state: string;
  phone_number: string | null;
  push_name: string | null;
  qr_available: number;
  last_ready_at: string | null;
  last_error: string | null;
  heartbeat_at: string | null;
  updated_at: string;
};

export async function saveSessionHealth(input: {
  state?: string;
  phoneNumber?: string | null;
  pushName?: string | null;
  qrAvailable?: boolean;
  lastError?: string | null;
  lastReadyAt?: string | null;
}): Promise<void> {
  if (!(await approvalsReady())) return;
  await execute(
    `INSERT INTO whatsapp_session
       (id, state, phone_number, push_name, qr_available, last_error, last_ready_at, heartbeat_at)
     VALUES (1,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE
       state = VALUES(state),
       phone_number = COALESCE(VALUES(phone_number), phone_number),
       push_name = COALESCE(VALUES(push_name), push_name),
       qr_available = VALUES(qr_available),
       last_error = VALUES(last_error),
       last_ready_at = COALESCE(VALUES(last_ready_at), last_ready_at),
       heartbeat_at = NOW()`,
    [
      input.state ?? "unknown",
      input.phoneNumber ?? null,
      input.pushName ?? null,
      input.qrAvailable ? 1 : 0,
      input.lastError ? String(input.lastError).slice(0, 1000) : null,
      input.lastReadyAt ? new Date(input.lastReadyAt).toISOString().slice(0, 19).replace("T", " ") : null,
    ]
  );
}

export async function getSessionHealth(): Promise<SessionHealth | null> {
  if (!(await approvalsReady())) return null;
  return queryOne<SessionHealth>("SELECT * FROM whatsapp_session WHERE id = 1");
}

/** Everything the task page's approval panel needs, in one query. */
export async function getPanel(deliverableId: number): Promise<{
  videoCode: string | null;
  waStatus: string;
  groupName: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  approvedBy: string | null;
  comment: string | null;
  lastError: string | null;
  hasGroup: boolean;
  hasVideo: boolean;
} | null> {
  if (!(await approvalsReady())) return null;

  const d = await queryOne<{
    video_code: string | null;
    wa_status: string;
    wa_sent_at: string | null;
    wa_viewed_at: string | null;
    wa_responded_at: string | null;
    wa_approved_by: string | null;
    wa_comment: string | null;
    wa_last_error: string | null;
    client_id: number;
    cloud_video_key: string | null;
    cloud_video_url: string | null;
    edited_link: string | null;
    group_name: string | null;
  }>(
    `SELECT d.video_code, d.wa_status, d.wa_sent_at, d.wa_viewed_at, d.wa_responded_at,
            d.wa_approved_by, d.wa_comment, d.wa_last_error, d.client_id,
            d.cloud_video_key, d.cloud_video_url, d.edited_link,
            g.group_name
       FROM deliverables d
       LEFT JOIN whatsapp_groups g
         ON g.client_id = d.client_id AND g.is_active = 1 AND g.is_default = 1
      WHERE d.id = ?
      LIMIT 1`,
    [deliverableId]
  );
  if (!d) return null;

  return {
    videoCode: d.video_code,
    waStatus: d.wa_status || "not_sent",
    groupName: d.group_name,
    sentAt: d.wa_sent_at,
    viewedAt: d.wa_viewed_at,
    respondedAt: d.wa_responded_at,
    approvedBy: d.wa_approved_by,
    comment: d.wa_comment,
    lastError: d.wa_last_error,
    hasGroup: Boolean(d.group_name !== null || (await getGroupsForClient(d.client_id)).length),
    hasVideo: Boolean(d.cloud_video_key || d.cloud_video_url || d.edited_link),
  };
}

/* ------------------------------ Client timeline ---------------------------- */

export type TimelineStep = {
  key: string;
  label: string;
  at: string | null;
  done: boolean;
  detail?: string | null;
};

/** The client-facing progress of one video, oldest step first. */
export async function getVideoTimeline(deliverableId: number): Promise<TimelineStep[] | null> {
  if (!(await approvalsReady())) return null;

  const d = await queryOne<{
    id: number;
    title: string;
    created_at: string;
    wa_status: string;
    wa_sent_at: string | null;
    wa_delivered_at: string | null;
    wa_viewed_at: string | null;
    wa_responded_at: string | null;
    wa_approved_by: string | null;
    wa_comment: string | null;
    posted_at: string | null;
    status: string;
  }>(
    `SELECT id, title, created_at, wa_status, wa_sent_at, wa_delivered_at, wa_viewed_at,
            wa_responded_at, wa_approved_by, wa_comment, posted_at, status
       FROM deliverables WHERE id = ?`,
    [deliverableId]
  );
  if (!d) return null;

  const approved = d.wa_status === "approved";
  const changes = d.wa_status === "changes_requested";

  return [
    { key: "uploaded", label: "Video uploaded", at: d.created_at, done: true },
    {
      key: "sent",
      label: "Sent to WhatsApp",
      at: d.wa_sent_at,
      done: Boolean(d.wa_sent_at),
    },
    {
      key: "viewed",
      label: "Viewed by client",
      at: d.wa_viewed_at,
      done: Boolean(d.wa_viewed_at),
    },
    {
      key: "approved",
      // The label follows what happened — showing "Approved" greyed out when
      // the client asked for changes misrepresents their answer.
      label: changes ? "Changes requested" : "Approved",
      at: d.wa_responded_at,
      done: approved || changes,
      detail: changes ? d.wa_comment : d.wa_approved_by ? `by ${d.wa_approved_by}` : null,
    },
    {
      key: "posted",
      label: "Posted",
      at: d.posted_at,
      done: d.status === "posted" || d.status === "completed",
    },
  ];
}
