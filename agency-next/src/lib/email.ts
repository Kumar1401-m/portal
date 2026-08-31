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

/**
 * Email links must be absolute — a mail client has no origin to resolve
 * "/portal" against, so a relative href simply does nothing when clicked.
 */
const absolute = (href: string) =>
  /^https?:\/\//i.test(href) ? href : `${env.appUrl}${href.startsWith("/") ? "" : "/"}${href}`;

const button = (href: string, label: string) =>
  `<p><a href="${esc(absolute(href))}" style="display:inline-block;background:#ea580c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;

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

/** Welcome + first-time credentials for a new staff member. */
export async function sendStaffWelcomeEmail(
  member: { name: string; email: string; role: string },
  password: string,
  loginUrl = "/login"
) {
  const roleLabel =
    member.role === "crm"
      ? "CRM"
      : member.role.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return sendEmail(
    member.email,
    "Your account is ready",
    `Welcome to the team, ${esc(member.name)}! 🎉`,
    `<p>An account has been created for you on <b>${esc(env.appName)}</b> as <b>${esc(roleLabel)}</b>.</p>
     <p>Here are your sign-in details:</p>
     <p><b>Email:</b> ${esc(member.email)}<br/><b>Password:</b> ${esc(password)}</p>
     ${button(loginUrl, "Sign in")}
     <p style="color:#6b7280;font-size:13px">For your security, please change this password after your first sign-in. If you weren't expecting this email, you can ignore it.</p>`
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

/**
 * Confirms to the client that a post is live. Sent by the n8n publisher right
 * after Instagram accepts the media, alongside the WhatsApp message.
 *
 * Deliberately short and links straight to the live post: the client's next
 * action is to look at it, not to read a report.
 */
export async function sendPostPublishedEmail(
  client: { company_name: string; contact_person?: string | null; email?: string | null },
  post: {
    title: string;
    permalink?: string | null;
    caption?: string | null;
    postedAt?: string | null;
    platform?: string;
  }
) {
  const hi = client.contact_person || client.company_name;
  const platform = post.platform || "Instagram";
  const when = post.postedAt
    ? new Date(post.postedAt.includes("T") ? post.postedAt : `${post.postedAt.replace(" ", "T")}Z`)
    : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
      : null;

  // A caption preview reassures the client that what went out is what they
  // approved, without making them open the app to check.
  const preview = post.caption
    ? `<div style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #ea580c;border-radius:4px;color:#475569;font-size:13px;white-space:pre-wrap">${esc(
        post.caption.length > 400 ? `${post.caption.slice(0, 400)}…` : post.caption
      )}</div>`
    : "";

  return sendEmail(
    client.email,
    `Your post is live on ${platform}`,
    "It's live 🎉",
    `<p>Hi ${esc(hi)},</p>
     <p><b>${esc(post.title)}</b> has been published to ${esc(platform)}${
       whenLabel ? ` on ${esc(whenLabel)}` : ""
     }.</p>
     ${preview}
     ${post.permalink ? button(post.permalink, `View on ${esc(platform)}`) : button("/portal", "Open your portal")}
     <p style="color:#6b7280;font-size:13px">Performance figures will appear in your portal within a day of posting.</p>`
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
