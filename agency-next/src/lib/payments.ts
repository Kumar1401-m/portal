/** Read queries for the Payments (invoices + payments) module. */
import "server-only";
import { query, queryOne } from "./db";

const n = (v: unknown) => Number(v ?? 0);

export type PaymentsSummary = {
  pending_amount: number;
  pending_count: number;
  month_received: number;
  total_received: number;
};

export async function getPaymentsSummary(): Promise<PaymentsSummary> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending_amount,
       SUM(status='pending') AS pending_count,
       COALESCE(SUM(CASE WHEN status='paid'
         AND DATE_FORMAT(paid_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN amount END),0) AS month_received,
       COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) AS total_received
     FROM payments`
  );
  return {
    pending_amount: n(row?.pending_amount),
    pending_count: n(row?.pending_count),
    month_received: n(row?.month_received),
    total_received: n(row?.total_received),
  };
}

export type InvoiceRow = {
  id: number;
  invoice_no: string;
  client_id: number;
  company_name: string;
  amount: number;
  tax: number;
  processing_fee: number;
  total: number;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  pending_payment_id: number | null;
};

export async function getInvoices(clientId?: number): Promise<InvoiceRow[]> {
  const where = clientId ? "WHERE i.client_id = ?" : "";
  const params = clientId ? [clientId] : [];
  const rows = await query<InvoiceRow>(
    `SELECT i.id, i.invoice_no, i.client_id, i.amount, i.tax, i.processing_fee, i.total,
            i.status, i.issue_date, i.due_date, c.company_name,
            (SELECT p.id FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending'
              ORDER BY p.id DESC LIMIT 1) AS pending_payment_id
     FROM invoices i JOIN clients c ON c.id = i.client_id
     ${where} ORDER BY i.created_at DESC LIMIT 100`,
    params
  );
  return rows.map((r) => ({
    ...r,
    amount: n(r.amount),
    tax: n(r.tax),
    processing_fee: n(r.processing_fee),
    total: n(r.total),
    pending_payment_id: r.pending_payment_id == null ? null : n(r.pending_payment_id),
  }));
}

export type PaymentRow = {
  id: number;
  invoice_id: number | null;
  invoice_no: string | null;
  client_id: number;
  company_name: string;
  amount: number;
  status: string;
  method: string | null;
  paid_at: string | null;
  created_at: string;
};

export async function getPayments(): Promise<PaymentRow[]> {
  const rows = await query<PaymentRow>(
    `SELECT p.id, p.invoice_id, i.invoice_no, p.client_id, c.company_name,
            p.amount, p.status, p.method, p.paid_at, p.created_at
     FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     JOIN clients c ON c.id = p.client_id
     ORDER BY p.created_at DESC LIMIT 100`
  );
  return rows.map((r) => ({ ...r, amount: n(r.amount) }));
}
