"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { publishHandoff } from "@/lib/instagram";
import { requireUser, type SessionUser } from "@/lib/auth";
import { notifyAdmins } from "@/lib/notify";
import { nextBestPostTime, AUTO_SCHEDULE_CATEGORIES } from "@/lib/zapier";
import { createRazorpayOrder, verifyRazorpaySignature } from "@/lib/razorpay";
import { sendPaidInvoiceEmail } from "@/lib/email";
import { getAgencyInbox } from "@/lib/settings";

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
            d.edited_link, ${cloudCol}, d.scheduled_at, c.ig_user_id, c.placeholder_values
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE d.id = ? AND d.client_id = ?`,
    [id, user.clientId]
  );
  if (!d) return { ok: false, error: "Not found." };
  if (!["content_review", "review"].includes(d.status)) {
    return { ok: false, error: "This item isn't awaiting your review." };
  }
  if (action === "changes" && !reason) {
    return { ok: false, error: "Please describe the change you'd like." };
  }

  // Gate 1: approving content_review approves the CONTENT → waiting_for_raw.
  const contentGate = action === "approve" && d.status === "content_review";
  let effective: string;
  const updates: Record<string, string | null> = {};
  if (action === "approve") {
    effective = contentGate ? "waiting_for_raw" : "approved";
    updates.approval_status = contentGate ? "pending" : "approved";
    updates.reject_reason = null;
  } else {
    effective = "changes_requested";
    updates.approval_status = "changes_requested";
    updates.reject_reason = reason;
  }
  updates.status = effective;

  // Final approval (not the content gate) of an auto-postable Instagram Reel:
  // hold it as "scheduled" for the client's best local engagement time
  // instead of posting the moment it's approved. The Zapier automation only
  // picks up rows once `scheduled_at` has actually arrived.
  let scheduledFor: string | null = null;
  if (effective === "approved") {
    const isVideoService =
      d.service === "video_editing" ||
      (d.service == null && String(d.video_type ?? "").toLowerCase() !== "poster");
    const autoPostable =
      isVideoService &&
      d.content_category != null &&
      AUTO_SCHEDULE_CATEGORIES.includes(d.content_category) &&
      Boolean(d.ig_user_id) &&
      Boolean(d.edited_link || d.cloud_video_key);
    if (autoPostable) {
      const ph = (d.placeholder_values && typeof d.placeholder_values === "object"
        ? d.placeholder_values
        : {}) as Record<string, unknown>;
      const country = typeof ph.country === "string" ? ph.country : null;
      // A time set by hand wins — only fall back to the automatic best slot
      // when nobody has chosen one.
      scheduledFor = d.scheduled_at
        ? String(d.scheduled_at).slice(0, 19).replace("T", " ")
        : nextBestPostTime(country);
      updates.status = "scheduled";
      updates.scheduled_at = scheduledFor;
      /*
       * The same handoff the admin path uses. `posting_status` alone was never
       * enough: the publish queue selects on `instagram_status`, so a client
       * approving their video used to schedule something the publisher could
       * not see — the one moment in the whole flow where auto-posting is
       * supposed to begin.
       */
      Object.assign(updates, publishHandoff({ ...d, scheduled_at: scheduledFor }));
    }
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
      ? contentGate
        ? `${d.title}: content approved — ready for the video.`
        : scheduledFor
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
    message: contentGate
      ? "Content approved — thank you! We'll start on the video."
      : action === "approve"
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

  const client = await queryOne<{
    company_name: string;
    contact_person: string | null;
    email: string | null;
  }>("SELECT company_name, contact_person, email FROM clients WHERE id = ?", [payment.client_id]);

  const invoice = payment.invoice_id
    ? await queryOne<{
        invoice_no: string;
        amount: string;
        tax: string;
        processing_fee: string;
      }>(
        "SELECT invoice_no, amount, tax, processing_fee FROM invoices WHERE id = ?",
        [payment.invoice_id]
      )
    : null;

  await notifyAdmins(
    "payment_received",
    "Payment received",
    `₹${Number(payment.amount).toLocaleString("en-IN")} received via Razorpay.`,
    "/payments"
  );

  // Receipt to the client, plus a copy to the agency's own inbox.
  if (client) {
    const agencyInbox = await getAgencyInbox();
    sendPaidInvoiceEmail(
      client,
      {
        invoice_no: invoice?.invoice_no ?? null,
        amount: invoice?.amount ?? null,
        tax: invoice?.tax ?? null,
        processing_fee: invoice?.processing_fee ?? null,
        total: payment.amount,
        method: "razorpay",
        reference: paymentId,
        paid_on: new Date().toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
      },
      agencyInbox
    ).catch(() => {});
  }

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
  if (d.status !== "waiting_for_raw") {
    return { ok: false, error: "This item isn't waiting for raw footage." };
  }

  await execute(
    "UPDATE deliverables SET raw_drive_link = ?, status = 'raw_uploaded' WHERE id = ?",
    [link, id]
  );

  await notifyAdmins(
    "general",
    "Raw footage received",
    `${d.title}: the client uploaded their raw footage — ready to edit.`,
    `/deliverables/${id}`
  );

  revalidatePath("/portal");
  revalidatePath("/portal/content");
  revalidatePath(`/portal/content/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  return { ok: true, message: "Thanks! Your raw footage was submitted — we'll start editing." };
}
