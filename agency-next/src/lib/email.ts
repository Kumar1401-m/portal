/**
 * Email service — no-op safe. When SMTP is not configured (the default here),
 * every send simply logs "[email skipped]" and returns false, so callers are
 * never blocked. nodemailer is imported dynamically ONLY when SMTP is enabled,
 * so the package isn't required until you actually turn email on.
 */
import "server-only";
import { env } from "./env";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const money = (n: number | string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(
    Number(n || 0)
  );

function wrap(title: string, bodyHtml: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#ea580c,#f59e0b);padding:20px 24px;color:#fff">
      <div style="font-size:18px;font-weight:700">${esc(env.appName)}</div>
    </div>
    <div style="padding:24px;color:#1f2937;font-size:14px;line-height:1.6">
      <h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>
      ${bodyHtml}
    </div>
    <div style="padding:16px 24px;color:#9ca3af;font-size:12px;border-top:1px solid #f1f5f9">
      This is an automated message from ${esc(env.appName)}.
    </div>
  </div>`;
}

/** Send an email. No-ops (logs) when SMTP is not configured. Never throws. */
export async function sendEmail(
  to: string | null | undefined,
  subject: string,
  title: string,
  bodyHtml: string
): Promise<boolean> {
  if (!to) return false;
  if (!env.mail.enabled) {
    console.info(`[email skipped — SMTP not configured] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    // Non-literal specifier keeps TS from requiring nodemailer's types; the
    // package is only needed once SMTP is actually enabled.
    const modName = "nodemailer";
    const nodemailer = await import(modName);
    const transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: { user: env.mail.user, pass: env.mail.password },
    });
    await transporter.sendMail({
      from: env.mail.from,
      to,
      subject: `${env.appName} — ${subject}`,
      html: wrap(title, bodyHtml),
    });
    console.info(`[email sent] to=${to} subject="${subject}"`);
    return true;
  } catch (err) {
    console.warn("[email failed]", err instanceof Error ? err.message : err);
    return false;
  }
}

const button = (href: string, label: string) =>
  `<p><a href="${esc(href)}" style="display:inline-block;background:#ea580c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;

/* ------------------------- Formal templates ------------------------- */

export async function sendOnboardingEmail(
  client: { company_name: string; contact_person?: string | null; email?: string | null },
  opts: { password?: string | null } = {}
) {
  const hi = client.contact_person || client.company_name;
  const creds = opts.password
    ? `<p>Your client portal login:</p>
       <p><b>Email:</b> ${esc(client.email)}<br/><b>Password:</b> ${esc(opts.password)}</p>
       ${button("/portal", "Open your portal")}`
    : `<p>We'll share your portal access shortly.</p>`;
  return sendEmail(
    client.email,
    "Welcome aboard",
    `Welcome, ${hi}! 🎉`,
    `<p>We're thrilled to have <b>${esc(client.company_name)}</b> on board.</p>${creds}`
  );
}

export async function sendInvoiceEmail(
  client: { company_name: string; email?: string | null },
  invoice: { invoice_no: string; total: number | string; due_date?: string | null }
) {
  return sendEmail(
    client.email,
    `Invoice ${invoice.invoice_no}`,
    `Invoice ${invoice.invoice_no}`,
    `<p>Hi ${esc(client.company_name)},</p>
     <p>Your invoice <b>${esc(invoice.invoice_no)}</b> for <b>${money(invoice.total)}</b> is ready${
       invoice.due_date ? ` (due ${esc(invoice.due_date)})` : ""
     }.</p>${button("/portal", "View & pay")}`
  );
}

/**
 * Asks the client to approve work. Used for both gates — the content brief
 * (`stage: "content"`) and the finished deliverable (`stage: "final"`).
 */
export async function sendApprovalRequestEmail(
  client: { company_name: string; contact_person?: string | null; email?: string | null },
  item: { title: string; stage: "content" | "final"; kind?: string | null; link?: string | null }
) {
  const hi = client.contact_person || client.company_name;
  const what =
    item.stage === "content"
      ? "the content plan"
      : `your ${item.kind && item.kind.toLowerCase() === "poster" ? "poster" : "final video"}`;
  const subject =
    item.stage === "content" ? "Content ready for your approval" : "Your deliverable is ready";

  return sendEmail(
    client.email,
    subject,
    item.stage === "content" ? "Ready for your approval" : "Ready for your review ✨",
    `<p>Hi ${esc(hi)},</p>
     <p>We've prepared ${what} for <b>${esc(item.title)}</b> and it's waiting on your go-ahead.</p>
     <p>Please take a look and either approve it or tell us what you'd like changed.</p>
     ${button(item.link || "/portal", "Review & approve")}
     <p style="color:#6b7280;font-size:13px">Nothing moves forward until you approve, so we'll hold here until we hear from you.</p>`
  );
}

export async function sendPaymentReceiptEmail(
  client: { company_name: string; email?: string | null },
  payment: { amount: number | string; invoice_no?: string | null; method?: string | null }
) {
  return sendEmail(
    client.email,
    "Payment received",
    "Payment received ✓",
    `<p>Hi ${esc(client.company_name)},</p>
     <p>We've received your payment of <b>${money(payment.amount)}</b>${
       payment.invoice_no ? ` for ${esc(payment.invoice_no)}` : ""
     }. Thank you!</p>`
  );
}

export async function sendNotificationEmail(
  to: string | null | undefined,
  title: string,
  body: string,
  link?: string | null
) {
  return sendEmail(
    to,
    title,
    title,
    `<p>${esc(body)}</p>${link ? button(link, "View in portal") : ""}`
  );
}
