/**
 * Razorpay integration — direct REST calls (no SDK dependency needed; the
 * API surface used here is just two endpoints). Credentials come from the
 * `settings` table (Settings → Billing), matching the same source the old
 * Express app read from.
 */
import "server-only";
import crypto from "crypto";
import { getSettings } from "./settings";

async function getConfig() {
  const s = await getSettings();
  const keyId = s.razorpay_key_id;
  const keySecret = s.razorpay_key_secret;
  return { keyId, keySecret, enabled: Boolean(keyId && keySecret) };
}

export async function isRazorpayEnabled(): Promise<boolean> {
  return (await getConfig()).enabled;
}

export type RazorpayOrder = { id: string; amount: number; currency: string };

/** Create an order for an amount in rupees. Throws if Razorpay isn't configured. */
export async function createRazorpayOrder(
  amountInr: number,
  receipt: string
): Promise<{ order: RazorpayOrder; keyId: string }> {
  const { keyId, keySecret, enabled } = await getConfig();
  if (!enabled) throw new Error("Online payment isn't set up yet — contact the agency.");

  const amountPaise = Math.round(amountInr * 100);
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("Razorpay order creation failed:", res.status, body);
    throw new Error("Could not start the payment. Please try again shortly.");
  }
  const order = (await res.json()) as { id: string; amount: number; currency: string };
  return { order: { id: order.id, amount: order.amount, currency: order.currency }, keyId };
}

/**
 * A payable link, for sending somewhere that isn't the portal.
 *
 * An order is only half a payment — it needs the checkout widget, which needs
 * a browser already signed in. A payment link is the whole thing in a URL, so
 * an invoice reminder in a WhatsApp group can be paid from the group.
 *
 * Razorpay's own notifications are turned off on purpose. The agency sends
 * this link itself, and a client who gets our WhatsApp message plus a Razorpay
 * SMS plus a Razorpay email for one invoice reads it as three chases.
 */
export type RazorpayPaymentLink = { id: string; shortUrl: string; expiresAt: string | null };

export async function createRazorpayPaymentLink(opts: {
  amountInr: number;
  description: string;
  customer?: { name?: string | null; email?: string | null; contact?: string | null };
  /** Days the link stays payable. Razorpay requires at least 15 minutes. */
  expiresInDays?: number;
  notes?: Record<string, string>;
}): Promise<RazorpayPaymentLink> {
  const { keyId, keySecret, enabled } = await getConfig();
  if (!enabled) throw new Error("Razorpay isn't set up — add the keys in Settings → Billing.");

  const amountPaise = Math.round(opts.amountInr * 100);
  if (amountPaise < 100) throw new Error("Razorpay won't take a payment under ₹1.");

  const days = Math.max(1, Math.trunc(opts.expiresInDays ?? 30));
  const expireBy = Math.floor(Date.now() / 1000) + days * 86400;

  /*
   * Only the contact fields we actually hold. Razorpay rejects an empty string
   * where it accepts a missing key, so a client with no phone number on file
   * must send no `contact` at all rather than `""`.
   */
  const customer: Record<string, string> = {};
  if (opts.customer?.name) customer.name = String(opts.customer.name).slice(0, 100);
  if (opts.customer?.email) customer.email = String(opts.customer.email).slice(0, 190);
  if (opts.customer?.contact) customer.contact = String(opts.customer.contact).slice(0, 20);

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      accept_partial: false,
      description: opts.description.slice(0, 2048),
      ...(Object.keys(customer).length ? { customer } : {}),
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: expireBy,
      ...(opts.notes ? { notes: opts.notes } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("Razorpay payment link failed:", res.status, body);
    // The reason is Razorpay's, and it is usually actionable ("payment links
    // not enabled for this account"), so it is worth carrying up rather than
    // flattening to "something went wrong".
    let reason = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { description?: string } };
      if (parsed.error?.description) reason = parsed.error.description;
    } catch {
      /* not JSON — the status is all we have */
    }
    throw new Error(`Razorpay refused to create the payment link: ${reason}`);
  }

  const link = (await res.json()) as { id: string; short_url: string };
  return {
    id: link.id,
    shortUrl: link.short_url,
    expiresAt: new Date(expireBy * 1000).toISOString().slice(0, 19).replace("T", " "),
  };
}

/** Verify the HMAC signature Razorpay returns after a successful checkout. */
export async function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): Promise<boolean> {
  const { keySecret, enabled } = await getConfig();
  if (!enabled) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expected === signature;
}
