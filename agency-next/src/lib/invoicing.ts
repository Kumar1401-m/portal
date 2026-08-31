/**
 * Raising an invoice, once, wherever the decision to bill is made.
 *
 * All of this lived inside the Payments form's server action — the number
 * sequence, the invoice row, the matching pending payment, the client's
 * notification, the payable link, the email. That was fine while a form was
 * the only thing that ever billed anybody. It stopped being fine the moment a
 * month's plan could bill too: the second caller would have needed its own
 * copy of the numbering, and two implementations of `INV-2026-0007` produce
 * the same number twice on the same day.
 *
 * So the form calls this and so does the plan. The form keeps what is
 * genuinely its own — reading a FormData, and redirecting afterwards.
 */
import "server-only";
import { queryOne, transaction, type ResultSetHeader } from "./db";
import { notifyClientById } from "./notify";
import { money } from "./utils";

const round2 = (x: number) => Math.round(x * 100) / 100;

export type RaiseInvoiceInput = {
  clientId: number;
  /** Before tax and any processing fee. */
  amount: number;
  tax?: number;
  processingFee?: number;
  /** The line the client reads on the invoice. */
  description?: string;
  dueDate?: string | null;
  notes?: string | null;
  /**
   * The month being billed, as `YYYY-MM`. Defaults to the month it is raised
   * in, which is what the Payments form has always meant — but a plan for
   * September agreed in August is billing September, and the invoice has to
   * say so or every report that groups by period puts it in the wrong month.
   */
  periodMonth?: string | null;
  createdBy?: number | null;
  /** Off for an invoice somebody wants to look at before the client does. */
};

export type RaisedInvoice = { id: number; invoiceNo: string; total: number };

/**
 * Write the invoice and tell the client.
 *
 * The invoice, its number and the pending payment go in one transaction:
 * `invoice_no` is derived from a count of existing invoices, so two callers a
 * moment apart would otherwise read the same count and mint the same number.
 *
 * Everything after the transaction is best-effort and deliberately so. The
 * invoice exists and is owed the moment the rows are written; a notification
 * that fails, or a Razorpay outage, must not undo it or throw into whatever
 * was being saved at the time.
 */
export async function raiseInvoice(input: RaiseInvoiceInput): Promise<RaisedInvoice | null> {
  const amount = round2(Number(input.amount) || 0);
  if (!input.clientId || !(amount > 0)) return null;

  const tax = round2(Number(input.tax) || 0);
  const processingFee = round2(Number(input.processingFee) || 0);
  const total = round2(amount + tax + processingFee);
  const description = (input.description || "").trim() || "Services";

  const client = await queryOne<{ id: number; company_name: string; email: string | null }>(
    "SELECT id, company_name, email FROM clients WHERE id = ?",
    [input.clientId]
  );
  if (!client) return null;

  const lineItems: { description: string; qty: number; rate: number }[] = [
    { description, qty: 1, rate: amount },
  ];
  if (processingFee > 0) {
    lineItems.push({ description: "Processing fee", qty: 1, rate: processingFee });
  }

  const { invoiceNo, invoiceId } = await transaction(async (conn) => {
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
       VALUES (?,?,?,?,?,?,'sent',CURDATE(),?,COALESCE(?, DATE_FORMAT(CURDATE(),'%Y-%m')),?,?,?)`,
      [
        no,
        input.clientId,
        amount,
        tax,
        processingFee,
        total,
        input.dueDate ?? null,
        input.periodMonth ?? null,
        input.notes ?? null,
        JSON.stringify(lineItems),
        input.createdBy ?? null,
      ]
    );
    const id = (inv as ResultSetHeader).insertId;
    await conn.execute(
      "INSERT INTO payments (invoice_id, client_id, amount, status) VALUES (?,?,?,'pending')",
      [id, input.clientId, total]
    );
    return { invoiceNo: no, invoiceId: id };
  });

  /*
   * The portal notification, which is the client's record of the invoice.
   *
   * It used to be the quiet half of a pair — this and an email with a payment
   * link in it. The email is gone: the client hears about an invoice in their
   * WhatsApp group, where the PDF and the weekly chase already go, and sees it
   * in their portal. Two channels that are read beat three where one isn't.
   */
  await notifyClientById(
    input.clientId,
    "payment_pending",
    `New invoice ${invoiceNo}`,
    `Amount: ${money(total)}. View and pay from your portal.`,
    "/portal/invoices",
    false
  ).catch(() => {});

  return { id: invoiceId, invoiceNo, total };
}
