-- ============================================================================
--  Agency ERP + CRM + Client Portal  —  MySQL Schema (normalized, InnoDB)
--  Charset: utf8mb4 for full emoji/unicode support in captions.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- USERS  (auth identities for every role)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(150) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('super_admin','admin','poster_designer','client') NOT NULL DEFAULT 'admin',
  phone         VARCHAR(30) DEFAULT NULL,
  avatar_url    VARCHAR(500) DEFAULT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME DEFAULT NULL,
  reset_token       VARCHAR(255) DEFAULT NULL,
  reset_expires_at  DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role),
  KEY idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- REFRESH TOKENS  (rotating JWT refresh tokens; supports logout/revoke)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME DEFAULT NULL,
  user_agent  VARCHAR(255) DEFAULT NULL,
  ip_address  VARCHAR(64) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rt_user (user_id),
  KEY idx_rt_hash (token_hash),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- CLIENTS  (agency customers / brands)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED DEFAULT NULL,      -- linked login (role=client)
  company_name      VARCHAR(190) NOT NULL,
  company_logo_url  VARCHAR(500) DEFAULT NULL,
  footer_watermark_url VARCHAR(500) DEFAULT NULL,
  contact_person    VARCHAR(150) DEFAULT NULL,
  phone             VARCHAR(30) DEFAULT NULL,
  email             VARCHAR(190) DEFAULT NULL,
  business_type     VARCHAR(120) DEFAULT NULL,
  instagram_link    VARCHAR(500) DEFAULT NULL,
  facebook_link     VARCHAR(500) DEFAULT NULL,
  youtube_link      VARCHAR(500) DEFAULT NULL,
  website           VARCHAR(500) DEFAULT NULL,
  monthly_package   VARCHAR(150) DEFAULT NULL,
  package_amount    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  joining_date      DATE DEFAULT NULL,
  renewal_date      DATE DEFAULT NULL,
  monthly_deliverables INT UNSIGNED NOT NULL DEFAULT 0,  -- target count per month
  payment_plan      ENUM('monthly','quarterly','half_yearly','yearly','one_time') NOT NULL DEFAULT 'monthly',
  notes             TEXT DEFAULT NULL,
  status            ENUM('active','inactive','paused','churned') NOT NULL DEFAULT 'active',
  ig_user_id        VARCHAR(64) DEFAULT NULL,           -- Meta Graph IG business id
  fb_page_id        VARCHAR(64) DEFAULT NULL,
  youtube_channel_id VARCHAR(64) DEFAULT NULL,          -- YouTube Data API channel id
  designer_id       BIGINT UNSIGNED DEFAULT NULL,       -- default designer for this client's tasks
  caption_settings  JSON DEFAULT NULL,                  -- {language, tone, length, emoji_style, target_audience, cta, seo_keywords, branded_hashtags}
  placeholder_values JSON DEFAULT NULL,                 -- {business_name, service, location, phone, whatsapp, website, offer, keywords}
  caption_template  TEXT DEFAULT NULL,                  -- per-client caption template (with {{placeholders}})
  services          JSON DEFAULT NULL,                   -- ["video_editing","poster_designing",...] — filtering/reporting only
  created_by        BIGINT UNSIGNED DEFAULT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_clients_status (status),
  KEY idx_clients_user (user_id),
  KEY idx_clients_renewal (renewal_date),
  KEY idx_clients_company (company_name),
  CONSTRAINT fk_clients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_clients_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- DELIVERABLES  (monthly content items — the core workflow entity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliverables (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id       BIGINT UNSIGNED NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT DEFAULT NULL,
  platform        VARCHAR(40) NOT NULL DEFAULT 'other',
  content_type    VARCHAR(60) DEFAULT NULL,             -- reel, post, short, poster...
  service         VARCHAR(40) DEFAULT NULL,             -- video_editing, poster_designing, website_development, meta_ads, content_writing, social_media_posting
  due_date        DATE DEFAULT NULL,
  scheduled_at    DATETIME DEFAULT NULL,
  posted_at       DATETIME DEFAULT NULL,
  posted_by       BIGINT UNSIGNED DEFAULT NULL,
  priority        ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  status          ENUM('pending','content_review','waiting_for_raw','raw_uploaded','editing','caption_ready',
                       'review','changes_requested','resolved','approved','scheduled',
                       'posted','completed','rejected','cancelled') NOT NULL DEFAULT 'pending',
  approval_status ENUM('pending','approved','changes_requested','rejected') NOT NULL DEFAULT 'pending',
  posting_status  ENUM('not_posted','scheduled','posted','rejected') NOT NULL DEFAULT 'not_posted',
  caption         TEXT DEFAULT NULL,
  content_hook    TEXT DEFAULT NULL,
  video_type      VARCHAR(60) DEFAULT NULL,
  promotion_type  VARCHAR(60) DEFAULT NULL,
  content_category VARCHAR(100) DEFAULT NULL,
  language        VARCHAR(60) DEFAULT NULL,
  target_audience VARCHAR(255) DEFAULT NULL,
  video_duration  VARCHAR(30) DEFAULT NULL,
  ai_prompt       TEXT DEFAULT NULL,
  custom_instructions TEXT DEFAULT NULL,
  writer_notes    TEXT DEFAULT NULL,
  videographer_notes TEXT DEFAULT NULL,
  editor_notes    TEXT DEFAULT NULL,
  client_notes    TEXT DEFAULT NULL,
  raw_drive_link  VARCHAR(700) DEFAULT NULL,
  edited_link     VARCHAR(700) DEFAULT NULL,
  thumbnail_url   VARCHAR(700) DEFAULT NULL,
  subtitle_link   VARCHAR(700) DEFAULT NULL,
  instagram_status VARCHAR(20) NOT NULL DEFAULT 'not_posted',
  facebook_status VARCHAR(20) NOT NULL DEFAULT 'not_posted',
  youtube_status  VARCHAR(20) NOT NULL DEFAULT 'not_posted',
  metric_views    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metric_reach    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metric_likes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metric_comments BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metric_shares   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  metric_saves    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  content_rating  TINYINT UNSIGNED DEFAULT NULL,
  reject_reason   TEXT DEFAULT NULL,
  ai_score        TINYINT UNSIGNED DEFAULT NULL,        -- 0..100 quality score
  campaign        VARCHAR(150) DEFAULT NULL,
  month_key       CHAR(7) DEFAULT NULL,                 -- YYYY-MM for fast grouping
  assigned_to     BIGINT UNSIGNED DEFAULT NULL,         -- admin/editor
  created_by      BIGINT UNSIGNED DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_deliv_client (client_id),
  KEY idx_deliv_status (status),
  KEY idx_deliv_due (due_date),
  KEY idx_deliv_month (month_key),
  KEY idx_deliv_platform (platform),
  KEY idx_deliv_service (service),
  KEY idx_deliv_approval (approval_status),
  CONSTRAINT fk_deliv_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_deliv_assignee FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_deliv_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- CAPTIONS  (permanent caption library; one deliverable may have versions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS captions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED DEFAULT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  platform      VARCHAR(40) DEFAULT NULL,
  campaign      VARCHAR(150) DEFAULT NULL,
  month_key     CHAR(7) DEFAULT NULL,
  body          TEXT NOT NULL,
  hashtags      TEXT DEFAULT NULL,
  cta           VARCHAR(500) DEFAULT NULL,
  hooks         TEXT DEFAULT NULL,
  is_ai_generated TINYINT(1) NOT NULL DEFAULT 0,
  created_by    BIGINT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cap_client (client_id),
  KEY idx_cap_deliv (deliverable_id),
  KEY idx_cap_month (month_key),
  KEY idx_cap_platform (platform),
  FULLTEXT KEY ft_cap_body (body, hashtags, cta),
  CONSTRAINT fk_cap_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_cap_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- AI ANALYSIS  (per-deliverable AI content + quality output)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_analysis (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED NOT NULL,
  summary        TEXT DEFAULT NULL,
  topic          VARCHAR(255) DEFAULT NULL,
  transcript     MEDIUMTEXT DEFAULT NULL,
  caption        TEXT DEFAULT NULL,
  cta            VARCHAR(500) DEFAULT NULL,
  hooks          TEXT DEFAULT NULL,
  seo_keywords   TEXT DEFAULT NULL,
  hashtags       TEXT DEFAULT NULL,
  thumbnail_title VARCHAR(255) DEFAULT NULL,
  best_time      VARCHAR(120) DEFAULT NULL,
  suggested_platform VARCHAR(60) DEFAULT NULL,
  reel_description TEXT DEFAULT NULL,
  alt_text       VARCHAR(500) DEFAULT NULL,
  social_copy    TEXT DEFAULT NULL,
  -- quality check
  quality_json   JSON DEFAULT NULL,                     -- {resolution, aspect_ratio, audio, subtitles, hook, copyright}
  quality_score  TINYINT UNSIGNED DEFAULT NULL,
  raw_json       JSON DEFAULT NULL,                     -- full model output for audit
  provider       VARCHAR(40) DEFAULT NULL,              -- 'openai' | 'heuristic'
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_deliv (deliverable_id),
  CONSTRAINT fk_ai_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- APPROVALS  (audit trail of client review decisions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED NOT NULL,
  client_id      BIGINT UNSIGNED NOT NULL,
  action         ENUM('approved','changes_requested','rejected') NOT NULL,
  reason         TEXT DEFAULT NULL,
  acted_by       BIGINT UNSIGNED DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_appr_deliv (deliverable_id),
  KEY idx_appr_client (client_id),
  CONSTRAINT fk_appr_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE,
  CONSTRAINT fk_appr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- FEEDBACK  (threaded change requests / comments per deliverable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED NOT NULL,
  author_id      BIGINT UNSIGNED DEFAULT NULL,
  author_role    ENUM('super_admin','admin','poster_designer','client') DEFAULT NULL,
  message        TEXT NOT NULL,
  is_resolved    TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fb_deliv (deliverable_id),
  CONSTRAINT fk_fb_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- INVOICES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no    VARCHAR(40) NOT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  amount        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  tax           DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  processing_fee DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total         DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  status        ENUM('draft','sent','paid','partial','overdue','cancelled') NOT NULL DEFAULT 'sent',
  issue_date    DATE DEFAULT NULL,
  due_date      DATE DEFAULT NULL,
  period_month  CHAR(7) DEFAULT NULL,
  notes         TEXT DEFAULT NULL,
  line_items    JSON DEFAULT NULL,
  created_by    BIGINT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_no (invoice_no),
  KEY idx_inv_client (client_id),
  KEY idx_inv_status (status),
  CONSTRAINT fk_inv_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- PAYMENTS  (Razorpay + manual)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id          BIGINT UNSIGNED DEFAULT NULL,
  client_id           BIGINT UNSIGNED NOT NULL,
  amount              DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency            CHAR(3) NOT NULL DEFAULT 'INR',
  status              ENUM('pending','paid','partial','failed','refunded','cancelled') NOT NULL DEFAULT 'pending',
  method              VARCHAR(40) DEFAULT NULL,          -- razorpay, upi, cash, bank
  razorpay_order_id   VARCHAR(80) DEFAULT NULL,
  razorpay_payment_id VARCHAR(80) DEFAULT NULL,
  razorpay_signature  VARCHAR(255) DEFAULT NULL,
  paid_at             DATETIME DEFAULT NULL,
  notes               TEXT DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pay_client (client_id),
  KEY idx_pay_invoice (invoice_id),
  KEY idx_pay_status (status),
  KEY idx_pay_order (razorpay_order_id),
  CONSTRAINT fk_pay_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- ANALYTICS SNAPSHOTS  (Meta Graph metrics per client per day)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id      BIGINT UNSIGNED NOT NULL,
  platform       VARCHAR(30) NOT NULL DEFAULT 'instagram',
  snapshot_date  DATE NOT NULL,
  followers      BIGINT DEFAULT 0,
  reach          BIGINT DEFAULT 0,
  impressions    BIGINT DEFAULT 0,
  views          BIGINT DEFAULT 0,
  likes          BIGINT DEFAULT 0,
  comments       BIGINT DEFAULT 0,
  shares         BIGINT DEFAULT 0,
  saves          BIGINT DEFAULT 0,
  engagement_rate DECIMAL(6,2) DEFAULT 0.00,
  raw_json       JSON DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_snapshot (client_id, platform, snapshot_date),
  KEY idx_an_client (client_id),
  KEY idx_an_date (snapshot_date),
  CONSTRAINT fk_an_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS  (in-app notification center)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(40) NOT NULL DEFAULT 'general',
  title       VARCHAR(190) NOT NULL,
  body        TEXT DEFAULT NULL,
  link        VARCHAR(300) DEFAULT NULL,
  is_read     TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id),
  KEY idx_notif_read (user_id, is_read),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- ACTIVITY LOGS  (audit trail for every meaningful mutation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED DEFAULT NULL,
  actor_name  VARCHAR(150) DEFAULT NULL,
  action      VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) DEFAULT NULL,
  entity_id   BIGINT UNSIGNED DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  meta_json   JSON DEFAULT NULL,
  ip_address  VARCHAR(64) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_log_user (user_id),
  KEY idx_log_entity (entity_type, entity_id),
  KEY idx_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- REPORTS  (generated report metadata / cache)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type        VARCHAR(40) NOT NULL,                     -- monthly, client, deliverables...
  client_id   BIGINT UNSIGNED DEFAULT NULL,
  period      CHAR(7) DEFAULT NULL,
  title       VARCHAR(190) DEFAULT NULL,
  payload     JSON DEFAULT NULL,
  generated_by BIGINT UNSIGNED DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rep_type (type),
  KEY idx_rep_client (client_id),
  CONSTRAINT fk_rep_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- SETTINGS  (agency-wide key/value config: branding, Razorpay, invoice, fees)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(64) NOT NULL,
  setting_value TEXT DEFAULT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- TASK CATEGORIES  (per-service category list; admin-editable in Settings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_categories (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service    VARCHAR(40) NOT NULL,
  name       VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_taskcat (service, name),
  KEY idx_taskcat_service (service)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- CLIENT FINGERPRINTS  (learned cues for AI auto client-detection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_fingerprints (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id  BIGINT UNSIGNED NOT NULL,
  cue_type   ENUM('logo','watermark','brand_text') NOT NULL DEFAULT 'brand_text',
  cue_value  VARCHAR(500) NOT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fp_client (client_id),
  KEY idx_fp_value (cue_value),
  CONSTRAINT fk_fp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- SCRIPTS  (script library)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id      BIGINT UNSIGNED NOT NULL,
  deliverable_id BIGINT UNSIGNED DEFAULT NULL,
  title          VARCHAR(255) NOT NULL,
  body           MEDIUMTEXT NOT NULL,
  platform       VARCHAR(40) DEFAULT NULL,
  campaign       VARCHAR(150) DEFAULT NULL,
  month_key      CHAR(7) DEFAULT NULL,
  created_by     BIGINT UNSIGNED DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scr_client (client_id),
  KEY idx_scr_deliv (deliverable_id),
  KEY idx_scr_month (month_key),
  CONSTRAINT fk_scr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_scr_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- THUMBNAILS  (thumbnail library)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thumbnails (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id      BIGINT UNSIGNED NOT NULL,
  deliverable_id BIGINT UNSIGNED DEFAULT NULL,
  title          VARCHAR(255) DEFAULT NULL,
  image_url      VARCHAR(700) NOT NULL,
  platform       VARCHAR(40) DEFAULT NULL,
  month_key      CHAR(7) DEFAULT NULL,
  created_by     BIGINT UNSIGNED DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_thumb_client (client_id),
  KEY idx_thumb_deliv (deliverable_id),
  CONSTRAINT fk_thumb_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_thumb_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- TASK COMMENTS  (Slack-style discussion per deliverable, with attachments)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_comments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED NOT NULL,
  author_id      BIGINT UNSIGNED DEFAULT NULL,
  author_role    ENUM('super_admin','admin','poster_designer','client') DEFAULT NULL,
  message        TEXT NOT NULL,
  mentions       JSON DEFAULT NULL,
  attachments    JSON DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tc_deliv (deliverable_id),
  CONSTRAINT fk_tc_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE,
  CONSTRAINT fk_tc_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- CONTENT VERSIONS  (deliverable field version history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_versions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deliverable_id BIGINT UNSIGNED NOT NULL,
  field          VARCHAR(40) NOT NULL,
  old_value      MEDIUMTEXT DEFAULT NULL,
  new_value      MEDIUMTEXT DEFAULT NULL,
  changed_by     BIGINT UNSIGNED DEFAULT NULL,
  actor_name     VARCHAR(150) DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ver_deliv (deliverable_id),
  CONSTRAINT fk_ver_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
