"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { queryOne, execute, transaction, type ResultSetHeader } from "@/lib/db";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { notifyClientById } from "@/lib/notify";
import { sendInvoiceEmail, sendPaidInvoiceEmail } from "@/lib/email";
import { getAgencyInbox } from "@/lib/settings";
import { money } from "@/lib/utils";

const round2 = (x: number) => Math.round(x * 100) / 100;
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

  const client = await queryOne<{ id: number; company_name: string; email: string | null }>(
    "SELECT id, company_name, email FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) redirect("/payments/new?error=client");

  const total = round2(amount + tax + processingFee);
  const lineItems: { description: string; qty: number; rate: number }[] = [
    { description, qty: 1, rate: amount },
  ];
  if (processingFee > 0) {
    lineItems.push({ description: "Processing fee", qty: 1, rate: processingFee });
  }

  let invoiceNo = "";
  try {
    invoiceNo = await transaction(async (conn) => {
      const year = new Date().getFullYear();
      const [seq] = await conn.execute(
        "SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?",
        [`INV-${year}-%`]
      );
      const nextN = Number((seq as unknown as { n: number }[])[0].n) + 1;
      const no = `INV-${year}-${String(nextN).padStart(4, "0")}`;

      const [inv] = await conn.execute(
        `INSERT INTO invoices
          (invoice_no, client_id, amount, tax, processing_fee, total, status, issue_date, due_date, period_month, notes, line_items, created_by)
         VALUES (?,?,?,?,?,?,'sent',CURDATE(),?,DATE_FORMAT(CURDATE(),'%Y-%m'),?,?,?)`,
        [
          no,
          clientId,
          amount,
          tax,
          processingFee,
          total,
          dueDate,
          notes,
          JSON.stringify(lineItems),
          user.id,
        ]
      );
      const invoiceId = (inv as ResultSetHeader).insertId;
      await conn.execute(
        "INSERT INTO payments (invoice_id, client_id, amount, status) VALUES (?,?,?,'pending')",
        [invoiceId, clientId, total]
      );
      return no;
    });
  } catch {
    redirect("/payments/new?error=failed");
  }

  // The portal notification always goes out — it's the client's record of the
  // invoice. The email is opt-out, ticked by default on the form.
  await notifyClientById(
    clientId,
    "payment_pending",
    `New invoice ${invoiceNo}`,
    `Amount: ${money(total)}. View and pay from your portal.`,
    "/portal/invoices",
    false
  );
  if (formData.get("send_email") !== null) {
    sendInvoiceEmail(client!, { invoice_no: invoiceNo, total, due_date: dueDate }).catch(() => {});
  }

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
  // Receipt to the client, plus a copy to the agency's own inbox — unless the
  // "Email receipt" box was unticked (paid in cash, receipt handed over, etc).
  if (formData.get("send_email") === null) {
    revalidatePath("/payments");
    return;
  }
  const agencyInbox = await getAgencyInbox();
  sendPaidInvoiceEmail(
    {
      company_name: payment!.company_name,
      contact_person: payment!.contact_person,
      email: payment!.email,
    },
    {
      invoice_no: payment!.invoice_no,
      amount: payment!.inv_amount,
      tax: payment!.inv_tax,
      processing_fee: payment!.inv_fee,
      total: payment!.amount,
      method,
      paid_on: new Date().toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    },
    agencyInbox
  ).catch(() => {});

  revalidatePath("/payments");
}
