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
    /*
     * Two, not ten — and capped however the environment is set.
     *
     * Ten is a sensible pool for one long-running server. This is not one:
     * Vercel runs a fresh instance per concurrent request, each with its own
     * pool, so ten here is ten *times however many instances are warm* against
     * a database that will have a connection limit of its own. Past that
     * limit MySQL closes new connections immediately, which arrives as the
     * same "the server closed the connection" as a stale socket — and no
     * amount of retrying fixes being over the limit.
     *
     * A serverless instance serves one request at a time. It does not need
     * ten.
     */
    connectionLimit: Math.min(4, Math.max(1, toInt(process.env.DB_CONNECTION_LIMIT, 2))),
    /*
     * The clock the database answers `NOW()` and `CURDATE()` with.
     *
     * This has always been Indian time — not by configuration but because the
     * server it ran on was — and the whole portal is built on it: due dates,
     * "overdue", posting windows, the footage slots, month keys. Nothing
     * converts; it is simply assumed.
     *
     * A managed host defaults to UTC, so moving without setting this would
     * shift every one of those by five and a half hours. Nothing would error.
     * Posts would go out at the wrong time and tasks would look due on the
     * wrong day, and it would take a while to notice why.
     *
     * Set explicitly so it is the same wherever the database lives.
     */
    timeZone: process.env.DB_TIME_ZONE || "+05:30",
    /*
     * Managed hosts require TLS and close the connection without it — which
     * arrives as the same unhelpful "connection lost" as everything else.
     * Off for a database on this machine, on for anything else.
     */
    ssl: (process.env.DB_SSL || "").toLowerCase() === "on",
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

  /**
   * The one model provider. Gemini is gone.
   *
   * Three models rather than one, because the three jobs are not alike and
   * paying for the biggest on all of them would empty a small balance in a
   * week:
   *
   *   `model`      writing and reading — captions, the group assistant, the
   *                video analyser. A reasoning model, thought about below.
   *   `fastModel`  the short, frequent, cheap calls where a client is waiting
   *                in a chat and a considered answer that arrives a minute
   *                later is worse than a plain one now.
   *   `transcribeModel`  what was said. Takes an mp4 whole, so a reel needs no
   *                audio extraction and the portal needs no ffmpeg.
   */
  /**
   * The model, and which one for which job.
   *
   * `model` writes: captions, scripts, anything going onto a client's feed.
   * `fastModel` answers: a client's question in a WhatsApp group, a voice
   * note to transcribe — work where a reply in two seconds is worth more than
   * a better sentence in twenty.
   *
   * Both default to a flash model rather than a pro one. Pro is refused
   * outright on a free key, and a caption reading a dozen high-detail frames
   * is the most expensive call this portal makes — so the default is the one
   * that works on the key an agency is most likely to have, and the override
   * is there for the day it is worth paying for.
   */
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
    fastModel: process.env.GEMINI_FAST_MODEL || "gemini-3-flash-preview",
    enabled: Boolean(process.env.GEMINI_API_KEY),
  },

  /**
   * YouTube, read-only, and a plain API key rather than a credential.
   *
   * Uploading needs OAuth and lives in n8n, which is why this portal holds no
   * Google credential at all. Subscriber counts and a video's view count are
   * public data, and public data on the YouTube Data API takes an API key and
   * nothing else — so the one thing the portal wants back from YouTube is the
   * one thing it can have without becoming a place that stores OAuth tokens.
   *
   * Enable "YouTube Data API v3" on any Google Cloud project and paste the key.
   * Without it the YouTube figures are absent rather than wrong.
   */
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || "",
    enabled: Boolean(process.env.YOUTUBE_API_KEY),
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

  /**
   * Shared secret for the n8n automation API (src/app/api/automation/*).
   *
   * The only key that reaches these endpoints. It used to fall back to
   * ZAPIER_API_KEY so an older install kept working through the changeover;
   * Zapier has since been removed entirely — Instagram posting runs through
   * n8n and the portal's own publisher — and a fallback to a credential
   * nothing issues any more is just a second key that can publish to a
   * client's Instagram account.
   */
  automation: {
    apiKey: process.env.N8N_API_KEY || "",
    enabled: Boolean(process.env.N8N_API_KEY),
    /** The cron secret, for the scheduled catch-up jobs. */
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
    /*
     * Reading ad spend needs a different token, not a wider one.
     *
     * `accessToken` is a Page token: it publishes reels and reads Instagram,
     * and it can never read an ad account whatever permissions are added to
     * it. Ads need a User or System User token carrying `ads_read`, from
     * somebody with a role on that ad account. Two separate settings, because
     * they are two separate things and quietly trying the Page token for ads
     * produces Meta error #200 and an afternoon of confusion.
     */
    adsAccessToken: process.env.META_ADS_ACCESS_TOKEN || "",
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
