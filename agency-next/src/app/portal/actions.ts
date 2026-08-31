"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { approvalHandoff } from "@/lib/instagram";
import { requireUser, type SessionUser } from "@/lib/auth";
import { notifyAdmins } from "@/lib/notify";
import { createRazorpayOrder, verifyRazorpaySignature } from "@/lib/razorpay";
import { ACCEPTS_RAW, rawUploadStatus } from "@/lib/portal";

export type PortalActionState = { ok: boolean; error?: string; message?: string };

type Row = {
  id: number;
  client_id: number;
  status: string;
  video_type: string | null;
  title: string;
  service: string | null;
  content_category: string | null;
  edited_link: string | null;
  cloud_video_key: string | null;
  scheduled_at: string | null;
  ig_user_id: string | null;
  /** The client's opt-in to unattended posting — the publisher requires it. */
  auto_publish: number | null;
  placeholder_values: unknown;
};

/** Shared client-side transition (approve / request changes), ownership-scoped. */
async function clientTransition(
  user: SessionUser,
  id: number,
  action: "approve" | "changes",
  reason: string
): Promise<PortalActionState> {
  if (!user.clientId) return { ok: false, error: "No client profile linked." };
  if (!id) return { ok: false, error: "Missing item." };

  // A video uploaded to our own storage has no edited_link, so the presence of
  // a cloud key counts as having a deliverable too.
  const cloudCol = (await hasColumn("deliverables", "cloud_video_key"))
    ? "d.cloud_video_key"
    : "NULL AS cloud_video_key";
  const d = await queryOne<Row>(
    `SELECT d.id, d.client_id, d.status, d.video_type, d.title, d.service, d.content_category,
            d.edited_link, ${cloudCol}, d.scheduled_at, c.ig_user_id, c.auto_publish,
            c.placeholder_values
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE d.id = ? AND d.client_id = ?`,
    [id, user.clientId]
  );
  if (!d) return { ok: false, error: "Not found." };
  if (d.status !== "review") {
    return { ok: false, error: "This item isn't awaiting your review." };
  }
  if (action === "changes" && !reason) {
    return { ok: false, error: "Please describe the change you'd like." };
  }

  /*
   * One gate, not two.
   *
   * There used to be a content gate here as well: a client approved the
   * written brief, which moved the task to `waiting_for_raw`, and then
   * approved the finished video later. The content half is gone — the copy is
   * now settled inside the agency and only the finished piece is put in front
   * of a client — so this is the final approval and nothing else. The check
   * above is what enforces it; a task in `content_review` is not the client's
   * to answer and is refused as not awaiting their review.
   */
  let effective: string;
  const updates: Record<string, string | null> = {};
  if (action === "approve") {
    effective = "approved";
    updates.approval_status = "approved";
    updates.reject_reason = null;
  } else {
    effective = "changes_requested";
    updates.approval_status = "changes_requested";
    updates.reject_reason = reason;
  }
  updates.status = effective;

  /*
   * A final approval hands the reel to the publisher, and the conditions for
   * that are `approvalHandoff`'s — the same ones the desk and the WhatsApp
   * group now ask. They used to be written out here, and only here, which is
   * how the other two paths came to ask something different.
   */
  let scheduledFor: string | null = null;
  if (effective === "approved") {
    Object.assign(updates, await approvalHandoff(id));
    // The time to tell them about: the one just picked, or the one somebody
    // had already set and the handoff deliberately left alone.
    scheduledFor =
      updates.status === "scheduled"
        ? updates.scheduled_at ??
          (d.scheduled_at ? String(d.scheduled_at).slice(0, 19).replace("T", " ") : null)
        : null;
  }

  const keys = Object.keys(updates);
  await execute(`UPDATE deliverables SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => updates[k]),
    id,
  ]);

  await execute(
    "INSERT INTO approvals (deliverable_id, client_id, action, reason, acted_by) VALUES (?,?,?,?,?)",
    [id, user.clientId, action === "approve" ? "approved" : "changes_requested", reason || null, user.id]
  );
  if (reason) {
    await execute(
      "INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)",
      [id, user.id, "client", reason]
    );
  }

  const msg =
    action === "approve"
      ? scheduledFor
        ? `${d.title}: approved by the client — auto-posting to Instagram at ${scheduledFor} UTC.`
        : `${d.title}: approved by the client.`
      : `${d.title}: client requested changes — ${reason}`;
  await notifyAdmins(
    action === "approve" ? "approval_needed" : "changes_requested",
    action === "approve" ? "Client approved" : "Client requested changes",
    msg,
    `/deliverables/${id}`
  );

  revalidatePath("/portal");
  revalidatePath("/portal/content");
  revalidatePath(`/portal/content/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/approvals");
  return {
    ok: true,
    message:
      action === "approve"
        ? scheduledFor
          ? "Approved — thank you! This will post automatically at the best time."
          : "Approved — thank you!"
        : "Thanks — we've noted your changes.",
  };
}

export async function clientApprove(
  _prev: PortalActionState,
  formData: FormData
): Promise<PortalActionState> {
  const user = await requireUser(["client"]);
  return clientTransition(user, Number(formData.get("deliverable_id")), "approve", "");
}

export async function clientRequestChanges(
  _prev: PortalActionState,
  formData: FormData
): Promise<PortalActionState> {
  const user = await requireUser(["client"]);
  return clientTransition(
    user,
    Number(formData.get("deliverable_id")),
    "changes",
    String(formData.get("reason") || "").trim()
  );
}

/* ----------------------------- Razorpay checkout ----------------------------- */

export type OrderState = {
  ok: boolean;
  error?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  key_id?: string;
  invoice_no?: string;
};

/** Start an online payment for one of the client's own invoices. */
export async function startInvoicePayment(invoiceId: number): Promise<OrderState> {
  const user = await requireUser(["client"]);
  if (!user.clientId) return { ok: false, error: "No client profile linked." };

  const inv = await queryOne<{ id: number; client_id: number; total: string; status: string; invoice_no: string }>(
    "SELECT id, client_id, total, status, invoice_no FROM invoices WHERE id = ? AND client_id = ?",
    [invoiceId, user.clientId]
  );
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status === "paid") return { ok: false, error: "This invoice is already paid." };

  let result: Awaited<ReturnType<typeof createRazorpayOrder>>;
  try {
    result = await createRazorpayOrder(Number(inv.total), inv.invoice_no);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not start payment." };
  }

  await execute(
    `UPDATE payments SET razorpay_order_id = ?
     WHERE invoice_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
    [result.order.id, invoiceId]
  );

  return {
    ok: true,
    order_id: result.order.id,
    amount: result.order.amount,
    currency: result.order.currency,
    key_id: result.keyId,
    invoice_no: inv.invoice_no,
  };
}

export type VerifyState = { ok: boolean; error?: string };

/** Confirm a completed Razorpay checkout and mark the invoice paid. */
export async function verifyInvoicePayment(
  orderId: string,
  paymentId: string,
  signature: string
): Promise<VerifyState> {
  const user = await requireUser(["client"]);
  const payment = await queryOne<{ id: number; invoice_id: number | null; client_id: number; amount: string }>(
    "SELECT id, invoice_id, client_id, amount FROM payments WHERE razorpay_order_id = ?",
    [orderId]
  );
  if (!payment) return { ok: false, error: "Payment record not found." };
  if (payment.client_id !== user.clientId) return { ok: false, error: "Not authorized." };

  const valid = await verifyRazorpaySignature(orderId, paymentId, signature);
  if (!valid) {
    await execute("UPDATE payments SET status = 'failed' WHERE id = ?", [payment.id]);
    return { ok: false, error: "Payment verification failed." };
  }

  await execute(
    `UPDATE payments SET status = 'paid', method = 'razorpay',
       razorpay_payment_id = ?, razorpay_signature = ?, paid_at = NOW()
     WHERE id = ?`,
    [paymentId, signature, payment.id]
  );
  if (payment.invoice_id) {
    await execute("UPDATE invoices SET status = 'paid' WHERE id = ?", [payment.invoice_id]);
  }

  await notifyAdmins(
    "payment_received",
    "Payment received",
    `₹${Number(payment.amount).toLocaleString("en-IN")} received via Razorpay.`,
    "/payments"
  );

  revalidatePath("/portal/invoices");
  revalidatePath("/portal");
  return { ok: true };
}

/* --------------------------- Raw footage submission --------------------------- */

/**
 * Client hands over raw footage for a task that's waiting on it. Sets
 * raw_drive_link and advances the existing "waiting_for_raw" → "raw_uploaded"
 * step of the pipeline — the admin side already treats raw_uploaded as the
 * signal to start editing.
 */
export async function submitRawFootage(
  _prev: PortalActionState,
  formData: FormData
): Promise<PortalActionState> {
  const user = await requireUser(["client"]);
  if (!user.clientId) return { ok: false, error: "No client profile linked." };

  const id = Number(formData.get("deliverable_id"));
  const link = String(formData.get("raw_drive_link") || "").trim();
  if (!id) return { ok: false, error: "Missing item." };
  if (!/^https?:\/\/.+/i.test(link)) return { ok: false, error: "Enter a valid link (https://…)." };

  const d = await queryOne<{ id: number; client_id: number; status: string; title: string }>(
    "SELECT id, client_id, status, title FROM deliverables WHERE id = ? AND client_id = ?",
    [id, user.clientId]
  );
  if (!d) return { ok: false, error: "Not found." };
  // Anything the agency has not started cutting yet. `waiting_for_raw` is the
  // case where we asked; `pending` is a slot on the month's plan that nobody
  // has asked about — and a client who already has the footage should not have
  // to wait to be asked for it before sending the link.
  if (!(ACCEPTS_RAW as readonly string[]).includes(d.status)) {
    return { ok: false, error: "We're already working on this one — send changes in the chat instead." };
  }

  // Only a piece we actually asked for footage on becomes ready to edit. One
  // sent ahead of the brief keeps its place in the queue — see rawUploadStatus.
  const next = rawUploadStatus(d.status);
  await execute(
    next
      ? "UPDATE deliverables SET raw_drive_link = ?, status = ? WHERE id = ?"
      : "UPDATE deliverables SET raw_drive_link = ? WHERE id = ?",
    next ? [link, next, id] : [link, id]
  );

  await notifyAdmins(
    "general",
    "Raw footage received",
    next
      ? `${d.title}: the client uploaded their raw footage — ready to edit.`
      : `${d.title}: the client sent footage before we asked. The content still needs writing.`,
    `/deliverables/${id}`
  );

  revalidatePath("/portal");
  revalidatePath("/portal/content");
  revalidatePath(`/portal/content/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  return {
    ok: true,
    message: next
      ? "Thanks! Your raw footage was submitted — we'll start editing."
      : "Thanks! We have your footage and it's saved against this one.",
  };
}
