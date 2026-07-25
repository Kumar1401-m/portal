/**
 * Email service (nodemailer). If SMTP is not configured the service becomes a
 * no-op that logs the message — the app keeps working without email.
 *
 * Besides the low-level `sendEmail`, this module exposes formal, branded
 * templates for the two business moments the agency cares about:
 *   • sendOnboardingEmail    — a client is created / given a portal login
 *   • sendInvoiceEmail       — an invoice is raised
 *   • sendPaymentReceiptEmail— a payment is received / recorded
 */
'use strict';

const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');

let transporter = null;
if (env.mail.enabled) {
  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: { user: env.mail.user, pass: env.mail.password },
  });
}

const BRAND = '#4527a0';

/* ---- small formatting helpers ---- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
const greeting = (c) => esc(c.contact_person || c.company_name || 'there');

/** A centred call-to-action button (table-based for email-client support). */
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="border-radius:8px;background:${BRAND};">
      <a href="${esc(href)}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-weight:bold;font-size:14px;text-decoration:none;border-radius:8px;">${esc(label)}</a>
    </td></tr></table>`;
}

/** A clean key/value detail block. `rows` is an array of [label, valueHtml]. */
function detailTable(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:6px 0 10px;">
    ${rows.map(([k, v], i) => `<tr>
      <td style="padding:9px 0;color:#777;font-size:13px;${i ? 'border-top:1px solid #f0eef7;' : ''}">${esc(k)}</td>
      <td style="padding:9px 0;color:#222;font-size:13px;font-weight:600;text-align:right;${i ? 'border-top:1px solid #f0eef7;' : ''}">${v}</td>
    </tr>`).join('')}
  </table>`;
}

/** Minimal branded HTML wrapper for all outgoing mail. */
function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f5fa;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:580px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #eee;">
    <div style="background:${BRAND};padding:20px 28px;">
      <span style="color:#fff;font-size:19px;font-weight:bold;letter-spacing:.2px;">${esc(env.appName)}</span>
    </div>
    <div style="padding:26px 28px;color:#333;font-size:14px;line-height:1.65;">
      <h2 style="margin:0 0 14px;color:${BRAND};font-size:18px;">${esc(title)}</h2>
      ${bodyHtml}
    </div>
    <div style="padding:16px 28px;color:#999;font-size:12px;border-top:1px solid #eee;line-height:1.6;">
      ${esc(env.appName)} · <a href="${esc(env.appUrl)}" style="color:${BRAND};text-decoration:none;">${esc(env.appUrl)}</a><br/>
      This is an automated message. You can reply to this email to reach our team.
    </div>
  </div></body></html>`;
}

/**
 * Send an email. Never throws — failures are logged so business flows are
 * never blocked by SMTP issues. Returns true only when actually sent.
 */
async function sendEmail(to, subject, title, bodyHtml) {
  if (!to) return false;
  if (!transporter) {
    logger.info(`[email skipped — SMTP not configured] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: env.mail.from,
      to,
      subject: `${env.appName} — ${subject}`,
      html: wrap(title, bodyHtml),
    });
    logger.info(`[email sent] to=${to} subject="${subject}"`);
    return true;
  } catch (err) {
    logger.warn('Email send failed:', err.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Formal business templates                                           */
/* ------------------------------------------------------------------ */

/**
 * Onboarding / welcome email. Include `opts.password` to deliver portal
 * credentials (only when a portal login was created for the client).
 * @param {object} client {company_name, contact_person, email, monthly_package, package_amount, monthly_deliverables}
 */
async function sendOnboardingEmail(client, opts = {}) {
  if (!client || !client.email) return false;
  const url = env.appUrl;
  const rows = [];
  if (opts.password) {
    rows.push(['Portal URL', `<a href="${esc(url)}" style="color:${BRAND};text-decoration:none;">${esc(url)}</a>`]);
    rows.push(['Login email', esc(client.email)]);
    rows.push(['Temporary password', `<span style="font-family:monospace;background:#f3f1fb;padding:2px 8px;border-radius:6px;">${esc(opts.password)}</span>`]);
  }
  if (client.monthly_package) rows.push(['Plan', esc(client.monthly_package)]);
  if (client.package_amount) rows.push(['Monthly fee', money(client.package_amount)]);
  if (client.monthly_deliverables) rows.push(['Deliverables / month', esc(client.monthly_deliverables)]);

  const body = `
    <p>Dear ${greeting(client)},</p>
    <p>Welcome aboard — we're delighted to partner with <strong>${esc(client.company_name)}</strong>. Our team is already setting up your account so we can start creating and delivering content for your brand.</p>
    ${opts.password ? '<p>Your client portal is now active. From there you can review content, approve deliverables and track your monthly progress in one place.</p>' : ''}
    ${rows.length ? detailTable(rows) : ''}
    ${opts.password ? button(url, 'Open your portal') : ''}
    ${opts.password ? '<p style="font-size:13px;color:#777;">For your security, please change this password after your first login.</p>' : ''}
    <p>If you have any questions, simply reply to this email — we're here to help.</p>
    <p style="margin-bottom:0;">Warm regards,<br/><strong>The ${esc(env.appName)} Team</strong></p>`;
  return sendEmail(client.email, 'Welcome to your client portal', `Welcome, ${client.company_name}!`, body);
}

/**
 * Formal invoice email.
 * @param {object} client  {company_name, contact_person, email}
 * @param {object} invoice {invoice_no, total, due_date, issue_date}
 */
async function sendInvoiceEmail(client, invoice) {
  if (!client || !client.email) return false;
  const url = `${env.appUrl}/#/payments`;
  const rows = [
    ['Invoice number', esc(invoice.invoice_no)],
    ['Amount due', money(invoice.total)],
  ];
  if (invoice.issue_date) rows.push(['Issued', esc(invoice.issue_date)]);
  if (invoice.due_date) rows.push(['Due date', esc(invoice.due_date)]);

  const body = `
    <p>Dear ${greeting(client)},</p>
    <p>Please find your invoice <strong>${esc(invoice.invoice_no)}</strong> for services provided by ${esc(env.appName)}.</p>
    ${detailTable(rows)}
    ${button(url, 'View & pay invoice')}
    <p>You can settle this securely online from your client portal. Kindly complete the payment by the due date to ensure uninterrupted service.</p>
    <p>Thank you for your continued business.</p>
    <p style="margin-bottom:0;">Warm regards,<br/><strong>The ${esc(env.appName)} Team</strong></p>`;
  return sendEmail(client.email, `Invoice ${invoice.invoice_no} — ${money(invoice.total)}`, `Invoice ${invoice.invoice_no}`, body);
}

/**
 * Formal payment-received receipt.
 * @param {object} client  {company_name, contact_person, email}
 * @param {object} payment {amount, invoice_no, method}
 */
async function sendPaymentReceiptEmail(client, payment) {
  if (!client || !client.email) return false;
  const rows = [['Amount paid', money(payment.amount)]];
  if (payment.invoice_no) rows.push(['Invoice', esc(payment.invoice_no)]);
  rows.push(['Date', today()]);
  if (payment.method) rows.push(['Method', esc(String(payment.method).toUpperCase())]);

  const body = `
    <p>Dear ${greeting(client)},</p>
    <p>Thank you! We're writing to confirm that your payment has been received. Here are the details for your records:</p>
    ${detailTable(rows)}
    <p style="color:#2e7d32;font-weight:600;">✓ Payment received — your account is up to date.</p>
    <p>We truly appreciate your trust in ${esc(env.appName)}.</p>
    <p style="margin-bottom:0;">Warm regards,<br/><strong>The ${esc(env.appName)} Team</strong></p>`;
  return sendEmail(client.email, `Payment received — ${money(payment.amount)}`, 'Payment received', body);
}

module.exports = {
  sendEmail,
  sendOnboardingEmail,
  sendInvoiceEmail,
  sendPaymentReceiptEmail,
};
