/**
 * The link a client taps to pay, resolved once and remembered.
 *
 * Two reasons this isn't created fresh each time it is needed. Razorpay bills
 * nothing for a link but does keep every one you make, so a weekly reminder
 * over three months would leave twelve live links against one invoice, any of
 * which could be paid — and the agency then has to work out which. And a
 * client who saved last week's message should find that link still works.
 *
 * So: cached on the invoice, reused until it expires or the invoice is paid.
 *
 * The fallback matters as much as the link. An agency without Razorpay
 * configured still needs to chase invoices, and the portal can already show
 * one and take payment — so a reminder falls back to that page rather than
 * refusing to send.
 */
import "server-only";
import { queryOne, execute, hasColumn } from "./db";
import { env } from "./env";
import { createRazorpayPaymentLink, isRazorpayEnabled } from "./razorpay";

export type PayLink = {
  url: string;
  /** True for a real Razorpay link; false for the portal page. */
  payable: boolean;
  /** Set when a Razorpay link was wanted but couldn't be made. */
  warning?: string;
};

const portalLink = (): PayLink => ({ url: `${env.appUrl}/portal/invoices`, payable: false });

/** A stored UTC DATETIME that hasn't passed. No expiry recorded counts as live. */
function stillLive(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const ms = Date.parse(`${expiresAt.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? false : ms > Date.now();
}

type InvoiceForLink = {
  id: number;
  invoice_no: string;
  total: number;
  status: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  payment_link: string | null;
  payment_link_expires_at: string | null;
};

/**
 * A payable URL for one invoice.
 *
 * Never throws. Every failure — no Razorpay, an account without payment links
 * enabled, a network blip — comes back as the portal link plus a warning the
 * caller can show. A reminder that doesn't go out because the payment
 * processor was briefly unhappy is worse than one carrying a link to the
 * portal.
 */
export async function paymentLinkForInvoice(invoiceId: number): Promise<PayLink> {
  const id = Math.trunc(Number(invoiceId));
  if (!id) return portalLink();

  const cached = await hasColumn("invoices", "payment_link");
  const cols = cached
    ? "i.payment_link, i.payment_link_expires_at"
    : "NULL AS payment_link, NULL AS payment_link_expires_at";

  const inv = await queryOne<InvoiceForLink>(
    `SELECT i.id, i.invoice_no, i.total, i.status, c.company_name, c.email, c.phone, ${cols}
       FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.id = ?`,
    [id]
  );
  if (!inv) return portalLink();

  // Still good: reuse it. The expiry was written by Razorpay in UTC and is
  // read back in UTC — `dateStrings` means it arrives as "2026-09-08 11:00:00"
  // with no zone, which Date.parse would otherwise read as local time.
  if (inv.payment_link && stillLive(inv.payment_link_expires_at)) {
    return { url: inv.payment_link, payable: true };
  }

  if (!(await isRazorpayEnabled())) return portalLink();

  try {
    const link = await createRazorpayPaymentLink({
      amountInr: Number(inv.total) || 0,
      description: `Invoice ${inv.invoice_no}${inv.company_name ? ` — ${inv.company_name}` : ""}`,
      customer: { name: inv.company_name, email: inv.email, contact: inv.phone },
      notes: { invoice_id: String(inv.id), invoice_no: inv.invoice_no },
    });
    if (cached) {
      await execute(
        "UPDATE invoices SET payment_link = ?, payment_link_id = ?, payment_link_expires_at = ? WHERE id = ?",
        [link.shortUrl, link.id, link.expiresAt, inv.id]
      );
    }
    return { url: link.shortUrl, payable: true };
  } catch (err) {
    return {
      ...portalLink(),
      warning: err instanceof Error ? err.message : "Couldn't create a Razorpay payment link.",
    };
  }
}
