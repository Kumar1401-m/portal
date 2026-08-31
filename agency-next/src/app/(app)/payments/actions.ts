"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { queryOne, transaction } from "@/lib/db";
import { requireUser, SUPER_ADMIN_ROLES, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { notifyClientById } from "@/lib/notify";
import { raiseInvoice } from "@/lib/invoicing";
import { getInvoiceDocument } from "@/lib/payments";
import { invoiceLink } from "@/lib/doc-link";
import { groupForClient } from "@/lib/reminder-outbox";
import { sendDocumentToGroup } from "@/lib/whatsapp-service-client";
import { money } from "@/lib/utils";

const METHODS = ["bank", "upi", "cash", "other"];

/* ----------------------------- Create invoice ----------------------------- */

export async function createInvoice(formData: FormData): Promise<void> {
  const user = await requireUser(SUPER_ADMIN_ROLES);

  const clientId = Number(formData.get("client_id"));
  const amount = Number(formData.get("amount") || 0);
  const tax = Number(formData.get("tax") || 0);
  const processingFee = Number(formData.get("processing_fee") || 0);
  const dueDate = String(formData.get("due_date") || "").trim() || null;
  const notes = String(formData.get("notes") || "").trim() || null;
  const description = String(formData.get("description") || "").trim() || "Services";

  if (!clientId || !(amount > 0)) {
    redirect("/payments/new?error=amount");
  }

  const client = await queryOne<{ id: number }>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) redirect("/payments/new?error=client");

  /*
   * The invoice itself is `raiseInvoice`, which the month plan also calls.
   *
   * The number sequence, the invoice row, the pending payment and the
   * client's notification were all written out here, for this form. A second place that decides to bill would have needed its
   * own copy — and two implementations of `INV-2026-0007` mint the same number
   * twice on the same day. What stays here is what is genuinely this form's:
   * reading a FormData, and where to go afterwards.
   */
  const raised = await raiseInvoice({
    clientId,
    amount,
    tax,
    processingFee,
    description,
    dueDate,
    notes,
    createdBy: user.id,
  }).catch(() => null);
  if (!raised) redirect("/payments/new?error=failed");

  revalidatePath("/payments");
  redirect("/payments");
}

/* ------------------------------- Mark paid ------------------------------- */

export async function markPaid(formData: FormData): Promise<void> {
  await requireUser(SUPER_ADMIN_ROLES);
  const paymentId = Number(formData.get("payment_id"));
  const methodRaw = String(formData.get("method") || "bank");
  const method = METHODS.includes(methodRaw) ? methodRaw : "bank";
  if (!paymentId) redirect("/payments");

  const payment = await queryOne<{
    id: number;
    invoice_id: number | null;
    client_id: number;
    amount: string;
    invoice_no: string | null;
    inv_amount: string | null;
    inv_tax: string | null;
    inv_fee: string | null;
    company_name: string;
    contact_person: string | null;
    email: string | null;
  }>(
    `SELECT p.id, p.invoice_id, p.client_id, p.amount, i.invoice_no,
            i.amount AS inv_amount, i.tax AS inv_tax, i.processing_fee AS inv_fee,
            c.company_name, c.contact_person, c.email
     FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     JOIN clients c ON c.id = p.client_id
     WHERE p.id = ?`,
    [paymentId]
  );
  if (!payment) redirect("/payments");

  await transaction(async (conn) => {
    await conn.execute(
      "UPDATE payments SET status='paid', method=?, paid_at=NOW() WHERE id = ?",
      [method, paymentId]
    );
    if (payment!.invoice_id) {
      await conn.execute("UPDATE invoices SET status='paid' WHERE id = ?", [payment!.invoice_id]);
    }
  });

  await notifyClientById(
    payment!.client_id,
    "payment_received",
    "Payment recorded",
    `Your payment of ${money(payment!.amount)} has been recorded. Thank you!`,
    "/portal/invoices",
    false
  );
  revalidatePath("/payments");
}

/* --------------------------- Delete a payment --------------------------- */

export type DeletePaymentState = { ok: boolean; error?: string };

/**
 * Remove one payment record. Super admin only — this is the money history, and
 * deleting a settled payment moves the reported revenue.
 *
 * If the payment was the settlement of an invoice, that invoice goes back to
 * unpaid rather than being left marked paid with nothing behind it.
 */
export async function deletePayment(paymentId: number): Promise<DeletePaymentState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Math.trunc(Number(paymentId));
  if (!id) return { ok: false, error: "Missing payment." };

  const p = await queryOne<{ id: number; invoice_id: number | null; status: string }>(
    "SELECT id, invoice_id, status FROM payments WHERE id = ?",
    [id]
  );
  if (!p) return { ok: false, error: "That payment no longer exists." };

  try {
    await transaction(async (conn) => {
      await conn.execute("DELETE FROM payments WHERE id = ?", [id]);
      if (p.invoice_id) {
        // Any other payment still standing against the invoice keeps it paid.
        const [rest] = await conn.execute(
          "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ? AND status = 'paid'",
          [p.invoice_id]
        );
        const stillPaid = Number((rest as unknown as { n: number }[])[0]?.n || 0) > 0;
        if (!stillPaid) {
          await conn.execute("UPDATE invoices SET status = 'sent' WHERE id = ?", [p.invoice_id]);
        }
      }
    });
  } catch {
    return { ok: false, error: "Could not delete that payment." };
  }

  for (const path of ["/payments", "/dashboard", "/reports"]) revalidatePath(path);
  return { ok: true };
}

/* --------------------------- Delete an invoice --------------------------- */

/**
 * Remove an invoice and every payment recorded against it. Super admin only.
 * Raised by mistake, duplicated, or a client that never went ahead — those are
 * the cases; a settled invoice should normally be credited, not erased.
 */
export async function deleteInvoice(invoiceId: number): Promise<DeletePaymentState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Math.trunc(Number(invoiceId));
  if (!id) return { ok: false, error: "Missing invoice." };

  const inv = await queryOne<{ id: number }>("SELECT id FROM invoices WHERE id = ?", [id]);
  if (!inv) return { ok: false, error: "That invoice no longer exists." };

  try {
    await transaction(async (conn) => {
      await conn.execute("DELETE FROM payments WHERE invoice_id = ?", [id]);
      await conn.execute("DELETE FROM invoices WHERE id = ?", [id]);
    });
  } catch {
    return { ok: false, error: "Could not delete that invoice." };
  }

  for (const path of ["/payments", "/dashboard", "/reports"]) revalidatePath(path);
  return { ok: true };
}

/* ------------------------- Send the invoice as a file ------------------------- */

export type SendInvoiceState = { ok: boolean; message: string };

/**
 * The invoice itself, into the client's WhatsApp group, as a PDF.
 *
 * The weekly chase already carries a link to it. This is for the moment
 * somebody asks for "the invoice" and means a document — one they can forward
 * to whoever actually pays things, which is rarely the person in the group.
 *
 * The service renders it from the same signed link the client would open, so
 * what arrives as a file is exactly what they would have seen by tapping it.
 */
export async function sendInvoicePdf(invoiceId: number): Promise<SendInvoiceState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const inv = await getInvoiceDocument(Math.trunc(Number(invoiceId)));
  if (!inv) return { ok: false, message: "That invoice no longer exists." };
  if (!(await canAccessClient(user, inv.client_id))) {
    return { ok: false, message: "That client isn't one of yours." };
  }

  const group = await groupForClient(inv.client_id, "payments");
  if (!group) {
    return {
      ok: false,
      message: "This client has no WhatsApp group linked — link one on their page first.",
    };
  }

  const paid = inv.status === "paid";
  const amount = `${inv.currency === "INR" ? "\u20b9" : `${inv.currency} `}${Math.round(inv.total).toLocaleString("en-IN")}`;

  const res = await sendDocumentToGroup({
    groupId: group.groupId,
    url: invoiceLink(inv.id, inv.invoice_no),
    // What the file is called in the client's downloads — and what they will
    // search for in eight months.
    filename: `${paid ? "Receipt" : "Invoice"} ${inv.invoice_no}.pdf`,
    caption: paid
      ? `\ud83e\uddfe Receipt ${inv.invoice_no} \u2014 ${amount}, received with thanks.`
      : `\ud83e\uddfe Invoice ${inv.invoice_no} \u2014 ${amount}.`,
  });

  if (!res.ok) return { ok: false, message: res.error };
  return { ok: true, message: `Sent to ${group.label}.` };
}
