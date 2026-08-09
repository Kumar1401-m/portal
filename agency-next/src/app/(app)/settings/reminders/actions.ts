"use server";

import { revalidatePath } from "next/cache";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import {
  composeReminder,
  SENDABLE,
  type ReminderKind,
} from "@/lib/reminder-messages";
import {
  cancelMessage,
  queueMessage,
  sendNow,
  outboxReady,
  REMINDER_TIMEZONE,
} from "@/lib/reminder-outbox";
import { localTimeToUtc } from "@/lib/zapier";

const KINDS = new Set(SENDABLE.map((s) => s.kind));

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

export type PreviewState = {
  text?: string | null;
  /** Why there is nothing to send. Shown instead of an empty message. */
  nothing?: string;
  /** A payment link we wanted and couldn't make. The message still stands. */
  warning?: string;
  error?: string;
  /** No group linked, so nothing can be sent to this client at all. */
  noGroup?: boolean;
};

/**
 * The message as the client would receive it, from live data.
 *
 * Separate from sending on purpose. These go to real groups, and the thing
 * that makes an automatic reminder safe — that its wording was reviewed once,
 * carefully — is replaced here by reading each one before it goes.
 */
export async function previewReminder(
  kind: string,
  clientId: number | null
): Promise<PreviewState> {
  await requireUser(SUPER_ADMIN_ROLES);
  if (!KINDS.has(kind as ReminderKind)) return { error: "Pick a reminder." };

  const spec = SENDABLE.find((s) => s.kind === kind)!;
  if (spec.perClient && !clientId) return { nothing: "Pick a client." };

  try {
    // Said before the message is composed, not after: there is no point
    // reading a chase for a client we have no way of reaching.
    if (spec.perClient && clientId && !(await groupForClient(clientId))) {
      return {
        noGroup: true,
        error:
          "This client has no WhatsApp group linked, so there's nowhere to send it. Link one in Settings → WhatsApp.",
      };
    }
    return await composeReminder(kind as ReminderKind, clientId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't work out what to say." };
  }
}

/* ------------------------------------------------------------------ *
 * Send, now or later
 * ------------------------------------------------------------------ */

export type SendState = {
  ok?: boolean;
  scheduled?: boolean;
  /** When it will go, in the admin's own clock, for saying so back to them. */
  whenLocal?: string;
  error?: string;
  warning?: string;
};

/**
 * Where a client is written to.
 *
 * The default group when there is one, then the oldest — the same order the
 * automatic reminders use, so a client is always addressed in the same chat
 * whichever sent it.
 */
async function groupForClient(
  clientId: number
): Promise<{ groupId: string; label: string } | null> {
  const row = await queryOne<{ group_id: string; group_name: string | null; company_name: string }>(
    `SELECT g.group_id, g.group_name, c.company_name
       FROM whatsapp_groups g JOIN clients c ON c.id = g.client_id
      WHERE g.client_id = ? AND g.is_active = 1
      ORDER BY g.is_default DESC, g.id ASC LIMIT 1`,
    [clientId]
  );
  if (!row) return null;
  return { groupId: row.group_id, label: row.group_name || row.company_name };
}

export async function sendReminderAction(
  _prev: SendState,
  formData: FormData
): Promise<SendState> {
  const user = await requireUser(SUPER_ADMIN_ROLES);

  if (!(await outboxReady())) {
    return { error: "The whatsapp_outbox table is missing — apply the pending changes in Settings." };
  }

  const kind = String(formData.get("kind") || "") as ReminderKind;
  if (!KINDS.has(kind)) return { error: "Pick a reminder." };

  const spec = SENDABLE.find((s) => s.kind === kind)!;
  const clientId = Number(formData.get("clientId")) || null;

  /*
   * The text that was on screen, not a fresh composition.
   *
   * Recomposing here would mean sending something nobody read: the preview and
   * the send are separate round trips, and the data can move between them. The
   * message a super admin approved is the message that goes.
   */
  const body = String(formData.get("body") || "").trim();
  if (!body) return { error: "There's no message to send." };
  if (body.length > 4000) return { error: "WhatsApp won't take a message this long." };

  // Where it goes. The team digest has its own group and no client.
  let groupId: string;
  let groupLabel: string;
  if (spec.perClient) {
    if (!clientId) return { error: "Pick a client." };
    const target = await groupForClient(clientId);
    if (!target) {
      return {
        error:
          "This client has no WhatsApp group linked, so there's nowhere to send it. Link one in Settings → WhatsApp.",
      };
    }
    groupId = target.groupId;
    groupLabel = target.label;
  } else {
    groupId = process.env.WHATSAPP_TEAM_GROUP_ID || "";
    groupLabel = "The team";
    if (!groupId) {
      return { error: "No team group is set. Add WHATSAPP_TEAM_GROUP_ID to the environment." };
    }
  }

  const when = String(formData.get("when") || "now");
  const author = { createdBy: user.id, createdByName: user.name || user.email };

  if (when === "later") {
    const date = String(formData.get("sendDate") || "").trim();
    const time = String(formData.get("sendTime") || "").trim();
    if (!date || !time) return { error: "Pick a date and a time." };

    // Read as Indian time, stored as UTC — the same conversion the posting
    // scheduler uses, so the whole portal means one thing by "6pm".
    const utc = localTimeToUtc(`${date}T${time}`, REMINDER_TIMEZONE);
    if (!utc) return { error: "That date and time didn't make sense." };

    // A minute or two in the past is a clock difference, not an intention.
    // Anything further back is a mistake worth catching, because it would go
    // out on the very next poll — which is not what "schedule" means.
    if (Date.parse(`${utc.replace(" ", "T")}Z`) < Date.now() - 5 * 60_000) {
      return { error: "That time has already passed. Pick one in the future." };
    }

    await queueMessage({
      kind,
      clientId: spec.perClient ? clientId : null,
      groupId,
      groupLabel,
      body,
      sendAt: utc,
      ...author,
    });
    revalidatePath("/settings/reminders");
    return { ok: true, scheduled: true, whenLocal: `${date} at ${time}` };
  }

  const res = await sendNow({
    kind,
    clientId: spec.perClient ? clientId : null,
    groupId,
    groupLabel,
    body,
    ...author,
  });
  revalidatePath("/settings/reminders");

  if (!res.ok) {
    return {
      error: res.error || "Couldn't send it.",
      // It stayed on the schedule rather than being lost, and the runner will
      // try again — worth saying, or someone sends it a second time by hand.
      warning: "It's still queued and will be retried automatically.",
    };
  }
  return { ok: true, scheduled: false };
}

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

export type CancelState = { ok?: boolean; error?: string };

export async function cancelReminderAction(
  _prev: CancelState,
  formData: FormData
): Promise<CancelState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(formData.get("id")) || 0;
  if (!id) return { error: "Nothing to cancel." };

  const done = await cancelMessage(id);
  revalidatePath("/settings/reminders");
  return done
    ? { ok: true }
    : { error: "Too late — that one is already on its way or has gone." };
}
