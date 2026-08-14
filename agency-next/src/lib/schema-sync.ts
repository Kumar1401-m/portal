/**
 * Applying the additive parts of the schema from inside the portal.
 *
 * The app degrades gracefully when a column it wants isn't there yet (see
 * `hasColumn`), which keeps a deploy safe but leaves the feature quietly
 * switched off until someone runs `database/migrate.js`. On a hosted database
 * with no shell to hand, that "someone" never gets round to it and a column
 * stays missing for weeks.
 *
 * So the super admin can apply them from Settings. Deliberately narrow:
 *
 *   - only the statements written out below, never anything from a request
 *   - only ADD COLUMN and CREATE TABLE IF NOT EXISTS, so nothing existing can
 *     be altered or dropped
 *   - skipped when the column is already there, so it's safe to run twice
 *
 * `database/migrate.js` remains the source of truth and does the same work;
 * this is the same list reachable without a terminal.
 */
import "server-only";
import { query, executeDdl, forgetColumn } from "./db";

type ColumnSpec = {
  table: string;
  column: string;
  /** The full column definition, exactly as migrate.js writes it. */
  definition: string;
  /** What the column is for, shown in Settings. */
  purpose: string;
  /**
   * Set when the column already exists and it is an ENUM that needs another
   * permitted value — a new role, say. "Missing" then means the value isn't
   * in the enum, and applying runs MODIFY rather than ADD.
   *
   * Widening an enum is additive in effect: existing rows keep their values
   * and nothing is dropped. The one way it could destroy data is a definition
   * that omits a value some row is already using, which MySQL would truncate
   * to an empty string — so `applyPendingColumns` refuses any MODIFY that
   * would drop a value the column currently permits.
   */
  requiresEnumValue?: string;
};

const EXPECTED: ColumnSpec[] = [
  {
    table: "clients",
    column: "is_personal",
    definition: "is_personal TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Marks a client as the agency's own, so it can be kept out of reports.",
  },
  {
    table: "clients",
    column: "monthly_posters",
    definition: "monthly_posters INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "Monthly poster target, counted separately from videos.",
  },
  {
    table: "clients",
    column: "category",
    definition: "category VARCHAR(10) NOT NULL DEFAULT ''",
    purpose: "The A / B / C tier shown in the Category column of the monthly report.",
  },
  {
    table: "deliverables",
    column: "reference_links",
    definition: "reference_links TEXT DEFAULT NULL",
    purpose: "Reference links, for when a client sends no raw footage.",
  },
  {
    table: "deliverables",
    column: "cloud_video_url",
    definition: "cloud_video_url VARCHAR(600) DEFAULT NULL",
    purpose: "Public URL of an uploaded video, when the bucket has one.",
  },
  {
    table: "deliverables",
    column: "cloud_video_key",
    definition: "cloud_video_key VARCHAR(400) DEFAULT NULL",
    purpose: "Object key of an uploaded video — what signed links are built from.",
  },

  /* --- Instagram auto-publishing (the n8n workflow's handshake) --- */
  {
    table: "deliverables",
    column: "hashtags",
    definition: "hashtags TEXT DEFAULT NULL",
    purpose: "Hashtags kept apart from the caption, appended when the post goes out.",
  },
  {
    table: "deliverables",
    column: "instagram_media_id",
    definition: "instagram_media_id VARCHAR(64) DEFAULT NULL",
    purpose: "The Instagram media id returned once a post is published.",
  },
  {
    table: "deliverables",
    column: "instagram_permalink",
    definition: "instagram_permalink VARCHAR(500) DEFAULT NULL",
    purpose: "Public link to the published post.",
  },
  {
    table: "deliverables",
    column: "instagram_posted_at",
    definition: "instagram_posted_at DATETIME DEFAULT NULL",
    purpose: "When Instagram accepted the post.",
  },
  {
    table: "deliverables",
    column: "post_attempts",
    definition: "post_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "How many publish attempts have been spent, so retries can give up.",
  },
  {
    table: "deliverables",
    column: "post_error",
    definition: "post_error TEXT DEFAULT NULL",
    purpose: "The last publishing failure, shown in the portal.",
  },
  {
    table: "deliverables",
    column: "post_locked_at",
    definition: "post_locked_at DATETIME DEFAULT NULL",
    purpose: "Claim lease — stops two automation runs posting the same video twice.",
  },
  {
    table: "users",
    column: "daily_target",
    definition: "daily_target INT UNSIGNED NOT NULL DEFAULT 0",
    purpose:
      "How many tasks this person is expected to finish a day. 0 means no target is set for them.",
  },
  {
    table: "clients",
    column: "content_approval",
    definition: "content_approval TINYINT(1) NOT NULL DEFAULT 1",
    purpose:
      "Does this client sign off the written content before work starts? On by default; off hands it straight to the team.",
  },
  {
    table: "deliverables",
    column: "facebook_status",
    definition: "facebook_status VARCHAR(20) NOT NULL DEFAULT 'not_posted'",
    purpose:
      "Whether the same post reached the client's Facebook Page — posted, failed, or not attempted.",
  },
  {
    table: "deliverables",
    column: "facebook_post_id",
    definition: "facebook_post_id VARCHAR(64) DEFAULT NULL",
    purpose:
      "The Page post's id, which the task page links to.",
  },
  {
    table: "deliverables",
    column: "facebook_error",
    definition: "facebook_error TEXT DEFAULT NULL",
    purpose:
      "Why the Page refused it, in words that say what to change.",
  },
  {
    table: "deliverables",
    column: "content_sent_at",
    definition: "content_sent_at DATETIME DEFAULT NULL",
    purpose: "When the written brief went to the client, so a second send is a deliberate one.",
  },
  {
    table: "clients",
    column: "auto_payment_reminders",
    definition: "auto_payment_reminders TINYINT(1) NOT NULL DEFAULT 0",
    purpose:
      "Chase this client's overdue invoices on WhatsApp automatically, with a payment link. Off unless chosen.",
  },
  {
    table: "clients",
    column: "ads_access_token",
    definition: "ads_access_token TEXT DEFAULT NULL",
    purpose:
      "A User or System User token with ads_read for this client. A Page token cannot read spend.",
  },
  {
    table: "clients",
    column: "meta_ad_account_id",
    definition: "meta_ad_account_id VARCHAR(64) DEFAULT NULL",
    purpose: "The client's Meta ad account (act_…), so their spend can be read from Meta.",
  },

  /* --- YouTube, posted alongside Instagram by the n8n runner --- */
  {
    table: "clients",
    column: "youtube_enabled",
    definition: "youtube_enabled TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Opt-in to posting this client's videos to YouTube as well. Off unless asked for.",
  },
  {
    table: "clients",
    column: "youtube_channel_id",
    definition: "youtube_channel_id VARCHAR(64) DEFAULT NULL",
    purpose: "Which channel to upload to, when the connected account owns several.",
  },
  {
    table: "deliverables",
    column: "youtube_status",
    definition:
      "youtube_status VARCHAR(20) NOT NULL DEFAULT 'none'", // none|scheduled|processing|posted|failed
    purpose: "Where this video is in the YouTube queue — the column the runner selects on.",
  },
  {
    table: "deliverables",
    column: "youtube_video_id",
    definition: "youtube_video_id VARCHAR(32) DEFAULT NULL",
    purpose: "The uploaded video's YouTube id.",
  },
  {
    table: "deliverables",
    column: "youtube_url",
    definition: "youtube_url VARCHAR(255) DEFAULT NULL",
    purpose: "Watch link, for the task page and the client's report.",
  },
  {
    table: "deliverables",
    column: "youtube_posted_at",
    definition: "youtube_posted_at DATETIME DEFAULT NULL",
    purpose: "When it went live on YouTube.",
  },
  {
    table: "deliverables",
    column: "youtube_attempts",
    definition: "youtube_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "Upload attempts so far — the budget that stops a broken video retrying for ever.",
  },
  {
    table: "deliverables",
    column: "youtube_error",
    definition: "youtube_error TEXT DEFAULT NULL",
    purpose: "Why the last upload failed, in YouTube's own words.",
  },
  {
    table: "deliverables",
    column: "youtube_locked_at",
    definition: "youtube_locked_at DATETIME DEFAULT NULL",
    purpose: "Claim lease — stops two runs uploading the same video twice.",
  },

  {
    table: "clients",
    column: "editor_id",
    definition: "editor_id BIGINT UNSIGNED DEFAULT NULL",
    purpose: "The client's default video editor — the video half of the pair with designer_id.",
  },
  {
    table: "clients",
    column: "ig_username",
    definition: "ig_username VARCHAR(100) DEFAULT NULL",
    purpose: "The client's Instagram @handle.",
  },
  {
    table: "clients",
    column: "ig_access_token",
    definition: "ig_access_token TEXT DEFAULT NULL",
    purpose: "Optional per-client Meta token; blank uses the agency-wide one.",
  },
  {
    table: "clients",
    column: "whatsapp_number",
    definition: "whatsapp_number VARCHAR(30) DEFAULT NULL",
    purpose: "Where the 'your post is live' WhatsApp message goes.",
  },
  {
    table: "clients",
    column: "auto_publish",
    definition: "auto_publish TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Opt-in to unattended posting. Off unless the client agrees to it.",
  },

  /* --- WhatsApp client approvals --- */
  {
    table: "deliverables",
    column: "video_code",
    definition: "video_code VARCHAR(20) DEFAULT NULL",
    purpose: "The short code (V245) a client types into WhatsApp to approve a video.",
  },
  {
    table: "deliverables",
    column: "wa_status",
    definition: "wa_status VARCHAR(24) NOT NULL DEFAULT 'not_sent'",
    purpose: "Where the WhatsApp approval has got to: sent, viewed, approved, and so on.",
  },
  {
    table: "deliverables",
    column: "wa_group_id",
    definition: "wa_group_id VARCHAR(64) DEFAULT NULL",
    purpose: "Which WhatsApp group the video was sent to.",
  },
  {
    table: "deliverables",
    column: "wa_message_id",
    definition: "wa_message_id VARCHAR(128) DEFAULT NULL",
    purpose: "The sent message's id, so delivery and read receipts can be matched back.",
  },
  {
    table: "deliverables",
    column: "wa_sent_at",
    definition: "wa_sent_at DATETIME DEFAULT NULL",
    purpose: "When the video went to WhatsApp.",
  },
  {
    table: "deliverables",
    column: "wa_delivered_at",
    definition: "wa_delivered_at DATETIME DEFAULT NULL",
    purpose: "When WhatsApp confirmed delivery to the client's device.",
  },
  {
    table: "deliverables",
    column: "wa_viewed_at",
    definition: "wa_viewed_at DATETIME DEFAULT NULL",
    purpose: "When the client read it — the Viewed step on their timeline.",
  },
  {
    table: "deliverables",
    column: "wa_responded_at",
    definition: "wa_responded_at DATETIME DEFAULT NULL",
    purpose: "When the client replied with a verdict.",
  },
  {
    table: "deliverables",
    column: "wa_approved_by",
    definition: "wa_approved_by VARCHAR(150) DEFAULT NULL",
    purpose: "The WhatsApp name of whoever approved it.",
  },
  {
    table: "deliverables",
    column: "wa_approved_phone",
    definition: "wa_approved_phone VARCHAR(40) DEFAULT NULL",
    purpose: "Their phone number, for the record.",
  },
  {
    table: "deliverables",
    column: "wa_comment",
    definition: "wa_comment TEXT DEFAULT NULL",
    purpose: "The change notes a client sent with CHANGE.",
  },
  {
    table: "deliverables",
    column: "wa_send_attempts",
    definition: "wa_send_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "How many times sending has been tried.",
  },
  {
    table: "deliverables",
    column: "wa_last_error",
    definition: "wa_last_error TEXT DEFAULT NULL",
    purpose: "Why the last send failed, shown on the task page.",
  },
  {
    table: "deliverables",
    column: "wa_approval_message_id",
    definition: "wa_approval_message_id VARCHAR(128) DEFAULT NULL",
    purpose: "Stops a redelivered WhatsApp reply approving the same video twice.",
  },
  {
    table: "video_analysis",
    column: "brand_seen",
    definition: "brand_seen TEXT DEFAULT NULL",
    purpose: "The logo, footer and contact details the AI read off the video.",
  },
  {
    table: "video_analysis",
    column: "context_used",
    definition: "context_used TEXT DEFAULT NULL",
    purpose: "The briefing about the business a caption was written from.",
  },
  {
    table: "video_analysis",
    column: "grounded",
    definition: "grounded TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Whether web search was on when the caption was written.",
  },
  {
    table: "video_analysis",
    column: "source_ref",
    definition: "source_ref VARCHAR(600) DEFAULT NULL",
    purpose: "Which video the caption describes, so replacing it can't leave the old one's caption behind.",
  },
  // The video_editor role. Three enums have to permit it: the one that decides
  // what a user can be, and the two that stamp who wrote a comment.
  {
    table: "users",
    column: "role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') NOT NULL DEFAULT 'admin'",
    purpose: "Lets you create video editor accounts.",
  },
  {
    table: "feedback",
    column: "author_role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL",
    purpose: "So feedback from a video editor records who wrote it.",
  },
  {
    table: "task_comments",
    column: "author_role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL",
    purpose: "So a comment from a video editor records who wrote it.",
  },
  // The payment link an invoice reminder carries. Cached on the invoice so a
  // client chased three weeks running is sent the same link each time, rather
  // than three live links against one bill.
  {
    table: "invoices",
    column: "payment_link",
    definition: "payment_link VARCHAR(500) DEFAULT NULL",
    purpose: "The Razorpay link a WhatsApp invoice reminder carries.",
  },
  {
    table: "invoices",
    column: "payment_link_id",
    definition: "payment_link_id VARCHAR(64) DEFAULT NULL",
    purpose: "Razorpay's own id for that link, for matching a payment back to it.",
  },
  {
    table: "invoices",
    column: "payment_link_expires_at",
    definition: "payment_link_expires_at DATETIME DEFAULT NULL",
    purpose: "When the cached payment link stops working and a fresh one is made.",
  },
];

/**
 * Tables the analytics and publishing features need. Same rules as the
 * columns: literal statements, `IF NOT EXISTS`, nothing that can destroy data.
 * Written without foreign keys deliberately — `migrate.js` adds them, but a
 * hosted database where the parent tables live in a different engine or
 * charset would reject the constraint and leave the feature unusable. The
 * app's queries never depend on the FK, only on the columns.
 */
type TableSpec = { table: string; purpose: string; ddl: string };

const EXPECTED_TABLES: TableSpec[] = [
  {
    table: "expenses",
    purpose:
      "What the agency spends — salaries, subscriptions, ad budgets, rent — with the recurring ones due again on a date.",
    ddl: `CREATE TABLE IF NOT EXISTS expenses (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title        VARCHAR(200) NOT NULL,
      category     VARCHAR(40) NOT NULL DEFAULT 'other',
      amount       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      currency     CHAR(3) NOT NULL DEFAULT 'INR',
      vendor       VARCHAR(150) DEFAULT NULL,
      due_on       DATE NOT NULL,
      paid_on      DATE DEFAULT NULL,
      repeats      VARCHAR(12) NOT NULL DEFAULT 'once',
      remind       TINYINT(1) NOT NULL DEFAULT 1,
      remind_days  INT UNSIGNED NOT NULL DEFAULT 3,
      client_id    BIGINT UNSIGNED DEFAULT NULL,
      note         TEXT DEFAULT NULL,
      created_by   BIGINT UNSIGNED DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_exp_due (due_on),
      KEY idx_exp_paid (paid_on),
      KEY idx_exp_category (category),
      KEY idx_exp_client (client_id),
      CONSTRAINT fk_exp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "ad_insights",
    purpose:
      "One row per client per day of Meta ad spend, impressions and leads — what the Ad management board reads.",
    ddl: `CREATE TABLE IF NOT EXISTS ad_insights (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      date        DATE NOT NULL,
      spend       DECIMAL(14,2) NOT NULL DEFAULT 0,
      currency    VARCHAR(8) NOT NULL DEFAULT 'INR',
      impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
      reach       BIGINT UNSIGNED NOT NULL DEFAULT 0,
      clicks      BIGINT UNSIGNED NOT NULL DEFAULT 0,
      leads       INT UNSIGNED NOT NULL DEFAULT 0,
      synced_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- The upsert key. One row per client per day is what lets a re-sync
      -- correct a figure Meta has restated instead of adding a second copy.
      UNIQUE KEY uniq_client_day (client_id, date),
      KEY idx_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "publish_attempts",
    purpose: "Audit trail of every Instagram publish attempt, including failures.",
    ddl: `CREATE TABLE IF NOT EXISTS publish_attempts (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      platform       VARCHAR(30) NOT NULL DEFAULT 'instagram',
      attempt_no     INT UNSIGNED NOT NULL DEFAULT 1,
      stage          VARCHAR(40) NOT NULL DEFAULT 'claimed',
      status         ENUM('processing','posted','failed','skipped') NOT NULL DEFAULT 'processing',
      container_id   VARCHAR(64) DEFAULT NULL,
      media_id       VARCHAR(64) DEFAULT NULL,
      permalink      VARCHAR(500) DEFAULT NULL,
      error_code     VARCHAR(60) DEFAULT NULL,
      error_message  TEXT DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      run_id         VARCHAR(80) DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pa_deliv (deliverable_id),
      KEY idx_pa_client (client_id),
      KEY idx_pa_created (created_at),
      KEY idx_pa_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_groups",
    purpose: "Which WhatsApp group belongs to which client — how a reply is attributed.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      group_id    VARCHAR(64) NOT NULL,
      group_name  VARCHAR(190) DEFAULT NULL,
      is_default  TINYINT(1) NOT NULL DEFAULT 1,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wa_group (group_id),
      KEY idx_wag_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_messages",
    purpose: "Every message from a client group — the record when an approval is disputed.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      wa_message_id  VARCHAR(128) DEFAULT NULL,
      group_id       VARCHAR(64) NOT NULL,
      group_name     VARCHAR(190) DEFAULT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      video_code     VARCHAR(20) DEFAULT NULL,
      sender_name    VARCHAR(150) DEFAULT NULL,
      sender_number  VARCHAR(40) DEFAULT NULL,
      direction      ENUM('in','out') NOT NULL DEFAULT 'in',
      message        TEXT DEFAULT NULL,
      parsed_command VARCHAR(24) DEFAULT NULL,
      message_time   DATETIME NOT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wa_msg (wa_message_id),
      KEY idx_wam_group (group_id),
      KEY idx_wam_deliv (deliverable_id),
      KEY idx_wam_time (message_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_send_log",
    purpose: "Every send attempt, retry and delivery receipt for approval videos.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_send_log (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      video_code     VARCHAR(20) DEFAULT NULL,
      group_id       VARCHAR(64) DEFAULT NULL,
      attempt_no     INT UNSIGNED NOT NULL DEFAULT 1,
      status         ENUM('queued','sending','sent','delivered','read','failed') NOT NULL DEFAULT 'queued',
      wa_message_id  VARCHAR(128) DEFAULT NULL,
      media_bytes    BIGINT UNSIGNED DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      error_code     VARCHAR(60) DEFAULT NULL,
      error_message  TEXT DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_wsl_deliv (deliverable_id),
      KEY idx_wsl_status (status),
      KEY idx_wsl_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "video_analysis",
    purpose: "What the AI saw in each video and the caption it wrote from it.",
    ddl: `CREATE TABLE IF NOT EXISTS video_analysis (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      state          VARCHAR(24) NOT NULL DEFAULT 'queued',
      file_uri       VARCHAR(500) DEFAULT NULL,
      file_name      VARCHAR(255) DEFAULT NULL,
      file_expires_at DATETIME DEFAULT NULL,
      source_ref     VARCHAR(600) DEFAULT NULL,
      model          VARCHAR(60) DEFAULT NULL,
      summary        TEXT DEFAULT NULL,
      spoken_language VARCHAR(40) DEFAULT NULL,
      topic          VARCHAR(190) DEFAULT NULL,
      mood           VARCHAR(60) DEFAULT NULL,
      on_screen_text TEXT DEFAULT NULL,
      scenes_json    JSON DEFAULT NULL,
      caption        TEXT DEFAULT NULL,
      hook           TEXT DEFAULT NULL,
      hashtags       TEXT DEFAULT NULL,
      brand_seen     TEXT DEFAULT NULL,
      context_used   TEXT DEFAULT NULL,
      grounded       TINYINT(1) NOT NULL DEFAULT 0,
      raw_json       JSON DEFAULT NULL,
      video_bytes    BIGINT UNSIGNED DEFAULT NULL,
      tokens_used    INT UNSIGNED DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      attempts       INT UNSIGNED NOT NULL DEFAULT 0,
      last_error     TEXT DEFAULT NULL,
      locked_at      DATETIME DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_va_deliv (deliverable_id),
      KEY idx_va_state (state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "client_fingerprints",
    purpose: "Logo and watermark cues confirmed for a client, used when writing captions.",
    ddl: `CREATE TABLE IF NOT EXISTS client_fingerprints (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      cue_type   ENUM('logo','watermark','brand_text') NOT NULL DEFAULT 'brand_text',
      cue_value  VARCHAR(500) NOT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fp_client (client_id),
      KEY idx_fp_value (cue_value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_reminders",
    purpose:
      "One row per reminder sent. The unique key is what stops a client being nudged twice.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_reminders (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      kind           VARCHAR(32) NOT NULL,
      scope_key      VARCHAR(96) NOT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      group_id       VARCHAR(64) DEFAULT NULL,
      sent_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wr_once (kind, scope_key),
      KEY idx_wr_client (client_id),
      KEY idx_wr_sent (sent_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "automation_runs",
    purpose:
      "When each scheduled job last ran — how the portal can say whether the automatic reminders are firing.",
    ddl: `CREATE TABLE IF NOT EXISTS automation_runs (
      job      VARCHAR(40) NOT NULL,
      ran_at   DATETIME NOT NULL,
      ok       TINYINT(1) NOT NULL DEFAULT 1,
      summary  VARCHAR(500) DEFAULT NULL,
      PRIMARY KEY (job)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_outbox",
    purpose:
      "Reminders written now and sent later, with the wording frozen as it was approved.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_outbox (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      kind            VARCHAR(32) NOT NULL DEFAULT 'custom',
      client_id       BIGINT UNSIGNED DEFAULT NULL,
      group_id        VARCHAR(64) NOT NULL,
      group_label     VARCHAR(190) DEFAULT NULL,
      body            TEXT NOT NULL,
      send_at         DATETIME NOT NULL,
      status          ENUM('scheduled','sending','sent','failed','cancelled') NOT NULL DEFAULT 'scheduled',
      attempts        INT UNSIGNED NOT NULL DEFAULT 0,
      last_error      TEXT DEFAULT NULL,
      wa_message_id   VARCHAR(128) DEFAULT NULL,
      created_by      BIGINT UNSIGNED DEFAULT NULL,
      created_by_name VARCHAR(150) DEFAULT NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at      DATETIME DEFAULT NULL,
      sent_at         DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_wo_due (status, send_at),
      KEY idx_wo_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_session",
    purpose: "Connection health of the WhatsApp account, shown on the settings page.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_session (
      id             TINYINT UNSIGNED NOT NULL DEFAULT 1,
      state          VARCHAR(32) NOT NULL DEFAULT 'disconnected',
      phone_number   VARCHAR(40) DEFAULT NULL,
      push_name      VARCHAR(150) DEFAULT NULL,
      qr_available   TINYINT(1) NOT NULL DEFAULT 0,
      last_ready_at  DATETIME DEFAULT NULL,
      last_error     TEXT DEFAULT NULL,
      heartbeat_at   DATETIME DEFAULT NULL,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
];

export type SchemaColumnStatus = ColumnSpec & { present: boolean };
export type SchemaTableStatus = { table: string; purpose: string; present: boolean };

/**
 * One information_schema round trip for the whole list.
 *
 * The columns are aliased and lowercased in SQL rather than in JS: MySQL
 * returns information_schema names in upper case, so reading `row.table_name`
 * gives undefined and every column looks missing — which then tries to add
 * columns that are already there.
 */
export async function schemaStatus(): Promise<SchemaColumnStatus[]> {
  // The tables to inspect come from EXPECTED itself, so adding a spec for a
  // new table above is all that's needed — no second list to keep in step.
  const tables = [...new Set(EXPECTED.map((c) => c.table.toLowerCase()))];
  const rows = await query<{ t: string; c: string; ty: string }>(
    `SELECT LOWER(TABLE_NAME) AS t, LOWER(COLUMN_NAME) AS c, COLUMN_TYPE AS ty
       FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`,
    tables
  );
  const types = new Map(rows.map((r) => [`${r.t}.${r.c}`, String(r.ty)]));

  return EXPECTED.map((c) => {
    const key = `${c.table}.${c.column}`.toLowerCase();
    const type = types.get(key);
    return {
      ...c,
      // An enum spec is satisfied by the value being permitted, not by the
      // column merely existing — it always exists.
      present: c.requiresEnumValue
        ? Boolean(type?.includes(`'${c.requiresEnumValue}'`))
        : types.has(key),
    };
  });
}

/** The values an existing ENUM column currently permits. */
function enumValues(columnType: string): string[] {
  return [...columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** Which of the analytics/publishing tables already exist. */
export async function tableStatus(): Promise<SchemaTableStatus[]> {
  const names = EXPECTED_TABLES.map((t) => t.table);
  const rows = await query<{ t: string }>(
    `SELECT LOWER(TABLE_NAME) AS t FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(",")})`,
    names
  );
  const have = new Set(rows.map((r) => r.t));
  return EXPECTED_TABLES.map(({ table, purpose }) => ({
    table,
    purpose,
    present: have.has(table.toLowerCase()),
  }));
}

export type ApplyResult = {
  added: string[];
  failed: { column: string; error: string }[];
};

/**
 * Add whatever is missing. Each statement is attempted on its own so one
 * failure doesn't strand the rest, and `hasColumn`'s cache is cleared for
 * anything added — otherwise this process would keep believing the column is
 * absent until it restarts.
 *
 * Tables are created before columns: a spec may add a column to a table this
 * same run is responsible for creating.
 */
export async function applyPendingColumns(): Promise<ApplyResult> {
  const added: string[] = [];
  const failed: { column: string; error: string }[] = [];

  // Checked first rather than relying on IF NOT EXISTS alone, so the result
  // reports what this run actually created instead of listing every table.
  const missingTables = new Set((await tableStatus()).filter((t) => !t.present).map((t) => t.table));
  for (const t of EXPECTED_TABLES) {
    if (!missingTables.has(t.table)) continue;
    try {
      // `ddl` is a literal from the list above, never from input.
      await executeDdl(t.ddl);
      added.push(`${t.table} (table)`);
    } catch (e) {
      failed.push({
        column: `${t.table} (table)`,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  for (const c of await schemaStatus()) {
    if (c.present) continue;
    try {
      if (c.requiresEnumValue) {
        /*
         * Widening an enum is the one statement here that touches something
         * that already exists, so it is checked before it runs: MySQL turns a
         * value dropped from an enum into an empty string on every row using
         * it, silently. Refusing beats explaining afterwards.
         */
        const row = await query<{ ty: string }>(
          `SELECT COLUMN_TYPE AS ty FROM information_schema.columns
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
          [c.table, c.column]
        );
        const current = enumValues(row[0]?.ty || "");
        const lost = current.filter((v) => !c.definition.includes(`'${v}'`));
        if (lost.length) {
          throw new Error(
            `would drop existing value(s) ${lost.join(", ")} — not applied`
          );
        }
        await executeDdl(`ALTER TABLE \`${c.table}\` MODIFY COLUMN \`${c.column}\` ${c.definition}`);
        added.push(`${c.table}.${c.column} (+${c.requiresEnumValue})`);
        continue;
      }

      // `definition` is a literal from the list above, never from input.
      await executeDdl(`ALTER TABLE \`${c.table}\` ADD COLUMN ${c.definition}`);
      forgetColumn(c.table, c.column);
      added.push(`${c.table}.${c.column}`);
    } catch (e) {
      failed.push({
        column: `${c.table}.${c.column}`,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return { added, failed };
}
