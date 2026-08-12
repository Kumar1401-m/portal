"use server";

import { revalidatePath } from "next/cache";
import { requireUser, STAFF_ROLES, ASSIGNABLE_ROLES, sqlRoleList } from "@/lib/auth";
import { queryOne, execute } from "@/lib/db";
import { canAccessClient } from "@/lib/crm";
import { sendEmail, sendApprovalRequestEmail } from "@/lib/email";
import { notifyClientById } from "@/lib/notify";
import { approvalChaseText, invoiceText, composeReminder } from "@/lib/reminder-messages";
import { paymentLinkForInvoice } from "@/lib/payment-links";
import { sendNow, groupForClient } from "@/lib/reminder-outbox";
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
        `SELECT name FROM users WHERE id = ? AND is_active = 1
          AND role IN (${sqlRoleList(ASSIGNABLE_ROLES)})`,
        [who]
      );
      if (!u) return { ok: false, text: "That team member isn't available." };

      await execute("UPDATE deliverables SET assigned_to = ? WHERE id = ?", [who, id]);
      revalidatePath("/deliverables");
      revalidatePath("/today");
      return { ok: true, text: `**${d.title}** is now assigned to **${u.name}**.` };
    }

    /*
     * Chase an approval, in the group where the client answers.
     *
     * Through the same composer and the same outbox as the scheduled chases,
     * so the client gets one voice however the message was triggered, and
     * every send lands in one log. Writing a second version of this wording
     * here is how a client ends up chased in two different tones.
     */
    if (kind === "approval_reminder") {
      const d = await queryOne<{
        title: string; client_id: number; status: string;
        video_code: string | null; company_name: string;
      }>(
        `SELECT d.title, d.client_id, d.status, d.video_code, c.company_name
           FROM deliverables d JOIN clients c ON c.id = d.client_id
          WHERE d.id = ?`,
        [id]
      );
      if (!d) return { ok: false, text: "I can't find that one." };
      if (!(await canAccessClient(user, d.client_id)))
        return { ok: false, text: "That isn't one of your clients." };
      if (!["content_review", "review"].includes(d.status)) {
        return {
          ok: false,
          text: `**${d.title}** isn't waiting on the client — it's ${d.status.replace(/_/g, " ")}.`,
        };
      }

      const target = await groupForClient(d.client_id);
      if (!target) {
        return {
          ok: false,
          text: `**${d.company_name}** has no WhatsApp group linked, so there's nowhere to send it.`,
        };
      }

      const body = approvalChaseText([{ title: d.title, video_code: d.video_code }]);
      const res = await sendNow({
        kind: "approval_chase",
        clientId: d.client_id,
        groupId: target.groupId,
        groupLabel: target.label,
        body,
        createdBy: user.id,
        createdByName: user.name || user.email,
      });
      revalidatePath("/deliverables");
      return res.ok
        ? { ok: true, text: `Reminded **${d.company_name}** about **${d.title}** on WhatsApp.` }
        : { ok: false, text: `Couldn't send it: ${res.error}. It's queued and will be retried.` };
    }

    /*
     * The two whole-client reminders — footage, and the month's plan.
     *
     * Both target a client rather than one task, because both are about
     * everything outstanding: four separate "send us your footage" messages
     * reads as a malfunction, and the client's job is the same either way.
     * `composeReminder` already gathers what is outstanding and returns a
     * reason when there is nothing, so this stays a dispatcher.
     */
    if (kind === "footage_reminder" || kind === "send_month_plan") {
      if (!(await canAccessClient(user, id))) return { ok: false, text: "Not your client." };
      const c = await queryOne<{ company_name: string }>(
        "SELECT company_name FROM clients WHERE id = ?",
        [id]
      );
      if (!c) return { ok: false, text: "I can't find that client." };

      const which = kind === "footage_reminder" ? "footage_due" : "monthly_plan";
      const composed = await composeReminder(which, id);
      if (!composed.text) {
        return { ok: false, text: composed.nothing || "There's nothing to send them." };
      }

      const target = await groupForClient(id);
      if (!target) {
        return {
          ok: false,
          text: `**${c.company_name}** has no WhatsApp group linked, so there's nowhere to send it.`,
        };
      }

      const res = await sendNow({
        kind: which,
        clientId: id,
        groupId: target.groupId,
        groupLabel: target.label,
        body: composed.text,
        createdBy: user.id,
        createdByName: user.name || user.email,
      });
      return res.ok
        ? {
            ok: true,
            text:
              kind === "footage_reminder"
                ? `Asked **${c.company_name}** for their footage on WhatsApp.`
                : `Sent **${c.company_name}** this month's plan on WhatsApp.`,
          }
        : { ok: false, text: `Couldn't send it: ${res.error}. It's queued and will be retried.` };
    }

    /*
     * Publish to Instagram, now.
     *
     * Straight to `publishNow`, which is the same path the Post now button on
     * the task page uses — including its refusals. It skips the clock and the
     * client's auto-publish preference, because asking for this is the missing
     * consent, but it cannot conjure an Instagram account or a video file, and
     * says so plainly when either is absent.
     */
    if (kind === "post_now") {
      const d = await queryOne<{ title: string; client_id: number; company_name: string }>(
        `SELECT d.title, d.client_id, c.company_name
           FROM deliverables d JOIN clients c ON c.id = d.client_id WHERE d.id = ?`,
        [id]
      );
      if (!d) return { ok: false, text: "That task no longer exists." };
      if (!(await canAccessClient(user, d.client_id))) return { ok: false, text: "Not your client." };

      const { publishNow } = await import("@/lib/instagram-publish");
      const res = await publishNow(id);
      revalidatePath("/deliverables");
      revalidatePath(`/deliverables/${id}`);

      if (res.ok) {
        return {
          ok: true,
          text:
            `**${d.title}** is live on ${d.company_name}'s Instagram.` +
            (res.permalink ? `\n\n${res.permalink}` : ""),
        };
      }
      return {
        ok: false,
        text: res.pending
          ? `Instagram is still encoding **${d.title}** — it will go out within 15 minutes.`
          : `Couldn't post **${d.title}**: ${res.error}`,
      };
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

      const amount = new Intl.NumberFormat("en-IN", {
        style: "currency", currency: "INR", maximumFractionDigits: 0,
      }).format(Number(inv.total));

      /*
       * WhatsApp first, because that is where the money comes from.
       *
       * An emailed invoice reminder asks someone to find an email, open a
       * portal and remember a password. The WhatsApp one carries a Razorpay
       * link they can pay from the chat, and it is the channel these clients
       * actually answer on. Same composer as the weekly automatic chase, so
       * the wording matches whatever else has been sent about this invoice.
       */
      const group = await groupForClient(inv.client_id);
      if (group) {
        const link = await paymentLinkForInvoice(id);
        const body = invoiceText([
          {
            invoice_no: inv.invoice_no,
            total: Number(inv.total) || 0,
            due_date: inv.due_date,
            payUrl: link.url,
            payable: link.payable,
          },
        ]);
        const res = await sendNow({
          kind: "invoice_due",
          clientId: inv.client_id,
          groupId: group.groupId,
          groupLabel: group.label,
          body,
          createdBy: user.id,
          createdByName: user.name || user.email,
        });
        if (res.ok) {
          await notifyClientById(inv.client_id, "general", "Payment reminder",
            `Invoice ${inv.invoice_no} for ${amount} is still open.`, "/portal/invoices", false);
          return {
            ok: true,
            text:
              `Reminder for **${inv.invoice_no}** (${amount}) sent to **${inv.company_name}** on WhatsApp` +
              (link.payable ? ", with a link they can pay from the chat." : "."),
          };
        }
        // Fall through to email rather than stopping — a reminder that reaches
        // them by some route beats one that reached them by none.
      }

      if (!inv.email) {
        return {
          ok: false,
          text: `${inv.company_name} has no WhatsApp group and no email address — nowhere to send it.`,
        };
      }

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
      WHERE is_active = 1 AND role IN (${sqlRoleList(ASSIGNABLE_ROLES)})
      ORDER BY name`
  );
}
