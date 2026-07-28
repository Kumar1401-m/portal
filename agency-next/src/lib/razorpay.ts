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
