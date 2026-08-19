/**
 * Links to a document that a client can open without signing in.
 *
 * The report and the invoice are things a client is *sent*. A link that lands
 * on a login page is a link nobody follows — most clients have portal
 * credentials somewhere in an email from months ago, and asking them to find
 * it in order to read this month's report is how the report goes unread.
 *
 * So the link carries its own permission, exactly as `video-link.ts` does for
 * an uploaded video: the token is the capability, and holding the link is
 * holding the right to read that one document. The same bargain as a Google
 * Drive "anyone with the link" share, which is what these were sent as before.
 *
 * The token is signed over what the document IS, not just its id — a report
 * link is bound to its month, so a link to August cannot be edited into
 * September, and an invoice link is bound to the invoice number, so it dies if
 * the invoice is ever reissued.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

export type DocKind = "report" | "invoice";

function sign(kind: DocKind, id: number, extra: string): string {
  return createHmac("sha256", env.jwt.secret)
    .update(`doc:${kind}:${id}:${extra}`)
    .digest("base64url")
    .slice(0, 32);
}

export function docToken(kind: DocKind, id: number, extra = ""): string {
  return sign(kind, id, extra);
}

export function verifyDocToken(
  kind: DocKind,
  id: number,
  extra: string,
  token: string
): boolean {
  const a = Buffer.from(sign(kind, id, extra));
  const b = Buffer.from(String(token || ""));
  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Absolute, because it is pasted into a WhatsApp message or an email. */
export function reportLink(clientId: number, month: string): string {
  return `${env.appUrl}/report/${clientId}?month=${month}&k=${docToken("report", clientId, month)}`;
}

export function invoiceLink(invoiceId: number, invoiceNo: string): string {
  return `${env.appUrl}/invoice/${invoiceId}?k=${docToken("invoice", invoiceId, invoiceNo)}`;
}
