"use server";

import { revalidatePath } from "next/cache";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { queryOne, execute } from "@/lib/db";
import { canAccessClient } from "@/lib/crm";
import { sendEmail, sendApprovalRequestEmail } from "@/lib/email";
import { notifyClientById } from "@/lib/notify";
import {
  answerQuestion,
  buildSnapshot,
  chartsFor,
  actionOffers,
  canRun,
  type AssistantChart,
  type ActionOffer,
  type ActionKind,
} from "@/lib/assistant";

export type AssistantReply = {
  ok: boolean;
  text: string;
  charts?: AssistantChart[];
  offers?: ActionOffer[];
};

/**
 * Answer a question for whoever is signed in. The user is resolved from the
 * session here — never passed in from the browser — so the scope of the answer
 * can't be tampered with by the caller.
 */
export async function askAssistant(question: string): Promise<AssistantReply> {
  const user = await requireUser(STAFF_ROLES);
  const q = String(question || "").slice(0, 500);
  try {
    const [text, snap, offers] = await Promise.all([
      answerQuestion(user, q),
      buildSnapshot(user),
      actionOffers(user, q),
    ]);
    return { ok: true, text, charts: chartsFor(q, snap), offers };
  } catch {
    return { ok: false, text: "Sorry — I couldn't reach the data just now. Try again in a moment." };
  }
}

export type RunResult = { ok: boolean; text: string };

/**
 * Carry out an action the assistant offered.
 *
 * Three of these reach a client, so nothing runs implicitly: the browser only
 * gets here after an explicit confirm, and the role is re-checked server-side
 * rather than trusted from whatever the widget rendered.
 */
export async function runAssistantAction(
  kind: ActionKind,
  targetId: number,
  extra?: { assigneeId?: number; message?: string }
): Promise<RunResult> {
  const user = await requireUser(STAFF_ROLES);
  if (!canRun(user.role, kind)) return { ok: false, text: "That isn't something your role can do." };
  const id = Math.trunc(Number(targetId));
  if (!id) return { ok: false, text: "Missing the item to act on." };

  try {
    if (kind === "request_approval") {
      const d = await queryOne<{ id: number; client_id: number; title: string; video_type: string | null }>(
        "SELECT id, client_id, title, video_type FROM deliverables WHERE id = ?",
        [id]
      );
      if (!d) return { ok: false, text: "That task no longer exists." };
      if (!(await canAccessClient(user, d.client_id))) return { ok: false, text: "Not your client." };

      await execute(
        "UPDATE deliverables SET status = 'review', approval_status = 'pending', reject_reason = NULL WHERE id = ?",
        [id]
      );
      const link = `/portal/content/${id}`;
      await notifyClientById(d.client_id, "approval_needed", "Your video is ready for review",
        `"${d.title}" — please review and approve or request changes.`, link, false);
      const c = await queryOne<{ company_name: string; contact_person: string | null; email: string | null }>(
        "SELECT company_name, contact_person, email FROM clients WHERE id = ?", [d.client_id]
      );
      if (c) sendApprovalRequestEmail(c, { title: d.title, stage: "final", kind: d.video_type, link }).catch(() => {});

      revalidatePath("/deliverables");
      revalidatePath("/approvals");
      return { ok: true, text: `Sent **${d.title}** to the client for approval.` };
    }

    if (kind === "assign") {
      const who = Math.trunc(Number(extra?.assigneeId));
      if (!who) return { ok: false, text: "Pick who it should go to." };
      const d = await queryOne<{ id: number; client_id: number; title: string }>(
        "SELECT id, client_id, title FROM deliverables WHERE id = ?", [id]
      );
      if (!d) return { ok: false, text: "That task no longer exists." };
      if (!(await canAccessClient(user, d.client_id))) return { ok: false, text: "Not your client." };
      const u = await queryOne<{ name: string }>(
        "SELECT name FROM users WHERE id = ? AND is_active = 1 AND role IN ('super_admin','admin','poster_designer','crm')",
        [who]
      );
      if (!u) return { ok: false, text: "That team member isn't available." };

      await execute("UPDATE deliverables SET assigned_to = ? WHERE id = ?", [who, id]);
      revalidatePath("/deliverables");
      revalidatePath("/today");
      return { ok: true, text: `**${d.title}** is now assigned to **${u.name}**.` };
    }

    if (kind === "payment_reminder") {
      const inv = await queryOne<{
        invoice_no: string; total: string; due_date: string | null;
        client_id: number; company_name: string; contact_person: string | null; email: string | null;
      }>(
        `SELECT i.invoice_no, i.total, i.due_date, i.client_id,
                c.company_name, c.contact_person, c.email
           FROM invoices i JOIN clients c ON c.id = i.client_id
          WHERE i.id = ? AND i.status <> 'paid'`,
        [id]
      );
      if (!inv) return { ok: false, text: "That invoice is already settled, or gone." };
      if (!inv.email) return { ok: false, text: `${inv.company_name} has no email address on file.` };

      const amount = new Intl.NumberFormat("en-IN", {
        style: "currency", currency: "INR", maximumFractionDigits: 0,
      }).format(Number(inv.total));

      const sent = await sendEmail(
        inv.email,
        `Invoice ${inv.invoice_no} — a gentle reminder`,
        "Just a reminder",
        `<p>Hi ${inv.contact_person || inv.company_name},</p>
         <p>A quick nudge that invoice <b>${inv.invoice_no}</b> for <b>${amount}</b> is still open${
           inv.due_date ? ` (due ${inv.due_date})` : ""
         }.</p>
         <p>You can settle it from your portal whenever convenient — and do ignore this if it's already on its way.</p>`
      );
      await notifyClientById(inv.client_id, "general", "Payment reminder",
        `Invoice ${inv.invoice_no} for ${amount} is still open.`, "/portal/invoices", false);

      return sent
        ? { ok: true, text: `Reminder for **${inv.invoice_no}** sent to ${inv.email}.` }
        : { ok: false, text: "Couldn't send that — check the SMTP settings." };
    }

    if (kind === "message_client") {
      const body = String(extra?.message || "").trim();
      if (body.length < 3) return { ok: false, text: "Give me something to say first." };
      if (!(await canAccessClient(user, id))) return { ok: false, text: "Not your client." };

      const c = await queryOne<{ company_name: string; contact_person: string | null; email: string | null }>(
        "SELECT company_name, contact_person, email FROM clients WHERE id = ?", [id]
      );
      if (!c?.email) return { ok: false, text: "That client has no email address on file." };

      const esc = (s: string) =>
        s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
      const sent = await sendEmail(
        c.email,
        "A note from your team",
        `Hello ${c.contact_person || c.company_name}`,
        `<p>${esc(body).replace(/\n/g, "<br/>")}</p>
         <p style="color:#6b7280;font-size:13px">Sent by ${esc(user.name)} at your agency.</p>`
      );
      await notifyClientById(id, "general", "Message from your team", body, "/portal", false);

      return sent
        ? { ok: true, text: `Message sent to **${c.company_name}** (${c.email}).` }
        : { ok: false, text: "Couldn't send that — check the SMTP settings." };
    }

    return { ok: false, text: "I don't know how to do that yet." };
  } catch {
    return { ok: false, text: "That didn't go through. Nothing was changed." };
  }
}

/** Team members the assistant can assign work to. */
export async function assignableTeam(): Promise<{ id: number; name: string; role: string }[]> {
  await requireUser(STAFF_ROLES);
  const { query } = await import("@/lib/db");
  return query<{ id: number; name: string; role: string }>(
    `SELECT id, name, role FROM users
      WHERE is_active = 1 AND role IN ('super_admin','admin','poster_designer','crm')
      ORDER BY name`
  );
}
