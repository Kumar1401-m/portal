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

export const env = {
  appName: process.env.APP_NAME || "NVK Hub",
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
    // Single long-lived httpOnly session cookie for this internal ERP.
    expiresDays: toInt(process.env.JWT_EXPIRES_DAYS, 7),
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
};
