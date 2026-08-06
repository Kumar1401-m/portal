/**
 * Centralised environment config for the Next.js app.
 * Reuses the SAME agency_erp MySQL database as the original portal, so no data
 * migration is needed. Values come from agency-next/.env.local (see .env.example).
 */
import "server-only";

const toInt = (v: string | undefined, fallback: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isNaN(n) ? fallback : n;
};

/**
 * Absolute base URL for links that leave the app — chiefly email, where a
 * relative path like "/portal" is meaningless to the mail client. Prefers an
 * explicit APP_URL, then the domain Vercel injects, then local dev.
 */
function resolveAppUrl(): string {
  const explicit = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}

export const env = {
  appName: process.env.APP_NAME || "NVK Hub",
  appUrl: resolveAppUrl(),
  isProd: process.env.NODE_ENV === "production",

  db: {
    host: process.env.DB_HOST || "localhost",
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "agency_erp",
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || "dev_access_secret_change_me",
    /**
     * How long a sign-in lasts, in minutes. Counted from sign-in, not from
     * last activity: an hour after signing in the session is over, whatever
     * the person is in the middle of.
     *
     * Supersedes JWT_EXPIRES_DAYS, which is no longer read — a value in days
     * cannot express an hour, and leaving both live would mean two settings
     * quietly disagreeing about the same thing.
     */
    expiresMinutes: toInt(process.env.SESSION_MINUTES, 60),
  },

  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    enabled: Boolean(process.env.OPENAI_API_KEY),
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-flash-lite-latest",
    enabled: Boolean(process.env.GEMINI_API_KEY),
  },

  mail: {
    host: process.env.SMTP_HOST || "",
    port: toInt(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.MAIL_FROM || "Agency ERP <no-reply@agency.com>",
    enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
  },

  // Shared-secret auth for the Zapier-facing REST API (src/app/api/zapier/*).
  // Not the session cookie — Zapier calls these as a plain authenticated API.
  zapier: {
    apiKey: process.env.ZAPIER_API_KEY || "",
    enabled: Boolean(process.env.ZAPIER_API_KEY),
  },

  /**
   * Shared secret for the n8n automation API (src/app/api/automation/*).
   *
   * Separate from the Zapier key on purpose: these endpoints can publish to a
   * client's Instagram account and write analytics history, so the credential
   * that reaches them should be revocable without breaking the older, read-
   * mostly Zapier integration. Falls back to the Zapier key only so an
   * existing install keeps working after the upgrade.
   */
  automation: {
    apiKey: process.env.N8N_API_KEY || process.env.ZAPIER_API_KEY || "",
    enabled: Boolean(process.env.N8N_API_KEY || process.env.ZAPIER_API_KEY),
    /** Vercel Cron's shared secret, for the scheduled catch-up jobs. */
    cronSecret: process.env.CRON_SECRET || "",
  },

  /**
   * WhatsApp Cloud API, used for the "your post is live" message.
   *
   * n8n normally sends this itself; the portal keeps its own copy of the
   * config so the same notification can be triggered from the UI, and so a
   * client without n8n still gets notified.
   */
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    apiVersion: process.env.META_API_VERSION || "v21.0",
    /** Template name for the post-published message, if using a template. */
    template: process.env.WHATSAPP_TEMPLATE_NAME || "",
    enabled: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN),
  },

  /** Meta Graph API — the agency-wide token, when a client has none of its own. */
  meta: {
    accessToken: process.env.META_ACCESS_TOKEN || "",
    apiVersion: process.env.META_API_VERSION || "v21.0",
    enabled: Boolean(process.env.META_ACCESS_TOKEN),
  },

  /**
   * The WhatsApp approval service (apps run separately — see whatsapp-service/).
   *
   * Two secrets pointing in opposite directions, deliberately not one:
   *   `serviceToken` — the portal presenting itself TO the service.
   *   `inboundKey`   — the service calling BACK into the portal.
   * Either can be rotated without touching the other, and a leak of one does
   * not grant the other direction.
   */
  whatsappService: {
    url: (process.env.WHATSAPP_SERVICE_URL || "").replace(/\/+$/, ""),
    serviceToken: process.env.WHATSAPP_SERVICE_TOKEN || "",
    inboundKey: process.env.WHATSAPP_SERVICE_KEY || "",
    /** Where the browser opens its Socket.IO connection for live updates. */
    socketUrl:
      process.env.NEXT_PUBLIC_WHATSAPP_SOCKET_URL ||
      process.env.WHATSAPP_SERVICE_URL ||
      "",
    enabled: Boolean(process.env.WHATSAPP_SERVICE_URL && process.env.WHATSAPP_SERVICE_TOKEN),
  },
};
