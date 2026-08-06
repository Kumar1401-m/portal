/**
 * Idempotent schema migration runner (safe to run repeatedly).
 *   node database/migrate.js   |   npm run db:migrate
 *
 * Adds columns/tables introduced after the initial schema without dropping
 * existing data. Checks information_schema before each ALTER so it never
 * errors on a second run. schema.sql remains the source of truth for fresh
 * installs; this file carries the same changes to already-seeded databases.
 */
'use strict';

const env = require('../src/config/env');
const { query, getPool } = require('../src/config/db');

async function columnExists(table, column) {
  const rows = await query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [env.db.database, table, column]
  );
  return rows.length > 0;
}

async function addColumn(table, column, definition) {
  if (await columnExists(table, column)) {
    console.log(`  = ${table}.${column} already present`);
    return;
  }
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
  console.log(`  + ${table}.${column} added`);
}

async function run(label, sql) {
  await query(sql);
  console.log(`  + ${label}`);
}

async function indexExists(table, indexName) {
  const rows = await query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
    [env.db.database, table, indexName]
  );
  return rows.length > 0;
}

/**
 * Add an index only when it's missing.
 *
 * `ADD UNIQUE KEY` has no IF NOT EXISTS in MySQL, and swallowing the error
 * instead would also hide the one that matters — a UNIQUE that can't be built
 * because the column already holds duplicates.
 */
async function addIndex(table, indexName, definition) {
  if (await indexExists(table, indexName)) {
    console.log(`  = ${table}.${indexName} already present`);
    return;
  }
  await query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  console.log(`  + ${table}.${indexName} added`);
}

async function main() {
  console.log('Running migrations ...');

  /* ---- Cluster A: client fields + invoice processing fee ---- */
  await addColumn('clients', 'youtube_link', 'youtube_link VARCHAR(500) DEFAULT NULL AFTER facebook_link');
  await addColumn('clients', 'footer_watermark_url', 'footer_watermark_url VARCHAR(500) DEFAULT NULL AFTER company_logo_url');
  await addColumn('clients', 'youtube_channel_id', 'youtube_channel_id VARCHAR(64) DEFAULT NULL AFTER fb_page_id');
  await addColumn('invoices', 'processing_fee', 'processing_fee DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER tax');

  /* ---- Cluster A: agency settings (key/value) ---- */
  await run('settings table', `
    CREATE TABLE IF NOT EXISTS settings (
      setting_key   VARCHAR(64) NOT NULL,
      setting_value TEXT DEFAULT NULL,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster B: per-client caption settings + placeholders ---- */
  await addColumn('clients', 'caption_settings', 'caption_settings JSON DEFAULT NULL');
  await addColumn('clients', 'placeholder_values', 'placeholder_values JSON DEFAULT NULL');
  await addColumn('clients', 'caption_template', 'caption_template TEXT DEFAULT NULL');

  /* ---- Cluster C: learned client fingerprints ---- */
  await run('client_fingerprints table', `
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster D: script library ---- */
  await run('scripts table', `
    CREATE TABLE IF NOT EXISTS scripts (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id     BIGINT UNSIGNED NOT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      title         VARCHAR(255) NOT NULL,
      body          MEDIUMTEXT NOT NULL,
      platform      VARCHAR(40) DEFAULT NULL,
      campaign      VARCHAR(150) DEFAULT NULL,
      month_key     CHAR(7) DEFAULT NULL,
      created_by    BIGINT UNSIGNED DEFAULT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_scr_client (client_id),
      KEY idx_scr_deliv (deliverable_id),
      KEY idx_scr_month (month_key),
      CONSTRAINT fk_scr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_scr_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster D: thumbnail library ---- */
  await run('thumbnails table', `
    CREATE TABLE IF NOT EXISTS thumbnails (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id     BIGINT UNSIGNED NOT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      title         VARCHAR(255) DEFAULT NULL,
      image_url     VARCHAR(700) NOT NULL,
      platform      VARCHAR(40) DEFAULT NULL,
      month_key     CHAR(7) DEFAULT NULL,
      created_by    BIGINT UNSIGNED DEFAULT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_thumb_client (client_id),
      KEY idx_thumb_deliv (deliverable_id),
      CONSTRAINT fk_thumb_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_thumb_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster D: deliverable version history ---- */
  await run('content_versions table', `
    CREATE TABLE IF NOT EXISTS content_versions (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      field         VARCHAR(40) NOT NULL,
      old_value     MEDIUMTEXT DEFAULT NULL,
      new_value     MEDIUMTEXT DEFAULT NULL,
      changed_by    BIGINT UNSIGNED DEFAULT NULL,
      actor_name    VARCHAR(150) DEFAULT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ver_deliv (deliverable_id),
      CONSTRAINT fk_ver_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster E: Task Workspace — content brief, notes, media, promotion ---- */
  await addColumn('deliverables', 'content_hook', 'content_hook TEXT DEFAULT NULL AFTER caption');
  await addColumn('deliverables', 'video_type', 'video_type VARCHAR(60) DEFAULT NULL AFTER content_type');
  await addColumn('deliverables', 'promotion_type', 'promotion_type VARCHAR(60) DEFAULT NULL AFTER video_type');
  await addColumn('deliverables', 'content_category', 'content_category VARCHAR(100) DEFAULT NULL AFTER promotion_type');
  await addColumn('deliverables', 'language', 'language VARCHAR(60) DEFAULT NULL AFTER content_category');
  await addColumn('deliverables', 'target_audience', 'target_audience VARCHAR(255) DEFAULT NULL AFTER language');
  await addColumn('deliverables', 'video_duration', 'video_duration VARCHAR(30) DEFAULT NULL AFTER target_audience');
  await addColumn('deliverables', 'ai_prompt', 'ai_prompt TEXT DEFAULT NULL');
  await addColumn('deliverables', 'custom_instructions', 'custom_instructions TEXT DEFAULT NULL');
  await addColumn('deliverables', 'writer_notes', 'writer_notes TEXT DEFAULT NULL');
  await addColumn('deliverables', 'videographer_notes', 'videographer_notes TEXT DEFAULT NULL');
  await addColumn('deliverables', 'editor_notes', 'editor_notes TEXT DEFAULT NULL');
  await addColumn('deliverables', 'client_notes', 'client_notes TEXT DEFAULT NULL');
  await addColumn('deliverables', 'subtitle_link', 'subtitle_link VARCHAR(700) DEFAULT NULL AFTER thumbnail_url');
  await addColumn('deliverables', 'posted_by', 'posted_by BIGINT UNSIGNED DEFAULT NULL AFTER posted_at');
  await addColumn('deliverables', 'instagram_status', "instagram_status VARCHAR(20) NOT NULL DEFAULT 'not_posted'");
  await addColumn('deliverables', 'facebook_status', "facebook_status VARCHAR(20) NOT NULL DEFAULT 'not_posted'");
  await addColumn('deliverables', 'youtube_status', "youtube_status VARCHAR(20) NOT NULL DEFAULT 'not_posted'");
  await addColumn('deliverables', 'metric_views', 'metric_views BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'metric_reach', 'metric_reach BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'metric_likes', 'metric_likes BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'metric_comments', 'metric_comments BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'metric_shares', 'metric_shares BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'metric_saves', 'metric_saves BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'content_rating', 'content_rating TINYINT UNSIGNED DEFAULT NULL');

  // Client-level designer assignment: every task for this client goes to this designer.
  await addColumn('clients', 'designer_id', 'designer_id BIGINT UNSIGNED DEFAULT NULL');

  /* ---- Cluster E: task discussion (Slack-style comments with attachments) ---- */
  await run('task_comments table', `
    CREATE TABLE IF NOT EXISTS task_comments (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      author_id      BIGINT UNSIGNED DEFAULT NULL,
      author_role    ENUM('super_admin','admin','client') DEFAULT NULL,
      message        TEXT NOT NULL,
      mentions       JSON DEFAULT NULL,
      attachments    JSON DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_tc_deliv (deliverable_id),
      CONSTRAINT fk_tc_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE,
      CONSTRAINT fk_tc_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---- Cluster F: add 'content_review' status (client content-approval gate) ---- */
  {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'deliverables' AND column_name = 'status' LIMIT 1`,
      [env.db.database]
    );
    if (col && !String(col.t).includes("'content_review'")) {
      await query(
        `ALTER TABLE deliverables MODIFY COLUMN status
         ENUM('pending','content_review','waiting_for_raw','raw_uploaded','editing','caption_ready',
              'review','changes_requested','resolved','approved','scheduled',
              'posted','completed','rejected','cancelled') NOT NULL DEFAULT 'pending'`
      );
      console.log('  + deliverables.status ENUM now includes content_review');
    } else {
      console.log('  = deliverables.status already has content_review');
    }
  }

  /* ---- Cluster G: add 'poster_designer' team role ---- */
  {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role' LIMIT 1`,
      [env.db.database]
    );
    if (col && !String(col.t).includes("'poster_designer'")) {
      await query(
        `ALTER TABLE users MODIFY COLUMN role
         ENUM('super_admin','admin','poster_designer','client') NOT NULL DEFAULT 'admin'`
      );
      console.log('  + users.role ENUM now includes poster_designer');
    } else {
      console.log('  = users.role already has poster_designer');
    }
  }

  /* ---- Cluster H: author_role ENUMs must allow poster_designer ---- */
  for (const tbl of ['feedback', 'task_comments']) {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = 'author_role' LIMIT 1`,
      [env.db.database, tbl]
    );
    if (col && !String(col.t).includes("'poster_designer'")) {
      await query(
        `ALTER TABLE ${tbl} MODIFY COLUMN author_role
         ENUM('super_admin','admin','poster_designer','client') DEFAULT NULL`
      );
      console.log(`  + ${tbl}.author_role ENUM now includes poster_designer`);
    } else {
      console.log(`  = ${tbl}.author_role already has poster_designer`);
    }
  }

  /* ---- Cluster I: service + category taxonomy (task organisation) ----
     Purely additive. Every task now carries a `service` (one of six agency
     services) and a category (reuses the existing `content_category` column).
     `video_type` is left untouched so the poster workflow, reports and the
     client portal keep working exactly as before. */
  await addColumn('deliverables', 'service', "service VARCHAR(40) DEFAULT NULL AFTER content_type");
  await addColumn('clients', 'services', 'services JSON DEFAULT NULL');

  {
    const [idx] = await query(
      `SELECT 1 AS x FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'deliverables' AND index_name = 'idx_deliv_service' LIMIT 1`,
      [env.db.database]
    );
    if (idx) {
      console.log('  = deliverables.idx_deliv_service already present');
    } else {
      await query('ALTER TABLE deliverables ADD INDEX idx_deliv_service (service)');
      console.log('  + deliverables.idx_deliv_service added');
    }
  }

  await run('task_categories table', `
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Seed the starter categories. INSERT IGNORE keeps admin edits/renames safe
  // on re-run, and admins can add their own from Settings → Task categories.
  {
    const SEED = {
      video_editing: ['Instagram Reel', 'YouTube Short', 'YouTube Long Video', 'Lead Magnet Reel',
        'Graphic Reel', 'Promotional Video', 'Testimonial Video', 'Educational Video',
        'Podcast', 'Event Video', 'Advertisement Video'],
      poster_designing: ['Educational Poster', 'Offer Poster', 'Festival Poster', 'Awareness Poster',
        'Promotional Poster', 'Announcement Poster', 'Social Media Post', 'Thumbnail', 'Banner'],
      website_development: ['Landing Page', 'Business Website', 'Portfolio Website',
        'Ecommerce Website', 'Maintenance', 'Bug Fix'],
      meta_ads: ['Lead Generation', 'Awareness Campaign', 'Engagement Campaign',
        'Traffic Campaign', 'Conversion Campaign', 'Remarketing'],
      content_writing: ['Instagram Caption', 'Facebook Caption', 'YouTube Description', 'Blog',
        'Ad Copy', 'Script', 'Lead Magnet PDF'],
      social_media_posting: ['Instagram Post', 'Instagram Story', 'Facebook Post',
        'YouTube Upload', 'LinkedIn Post', 'Scheduled Posting'],
    };
    let seeded = 0;
    for (const [service, names] of Object.entries(SEED)) {
      for (let i = 0; i < names.length; i += 1) {
        const res = await query(
          `INSERT IGNORE INTO task_categories (service, name, sort_order) VALUES (?,?,?)`,
          [service, names[i], i]
        );
        seeded += res.affectedRows || 0;
      }
    }
    console.log(`  + task_categories seeded (${seeded} new)`);
  }

  // Backfill: existing posters keep their identity, everything else is video
  // editing. Admins can re-tag from the task list.
  {
    const res = await query(
      `UPDATE deliverables
       SET service = IF(LOWER(COALESCE(video_type,'')) = 'poster', 'poster_designing', 'video_editing')
       WHERE service IS NULL OR service = ''`
    );
    console.log(`  + deliverables.service backfilled (${res.affectedRows} rows)`);
  }

  /* ---- Cluster J: 'crm' team role — scoped, per-client staff access ---- */
  {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role' LIMIT 1`,
      [env.db.database]
    );
    if (col && !String(col.t).includes("'crm'")) {
      await query(
        `ALTER TABLE users MODIFY COLUMN role
         ENUM('super_admin','admin','poster_designer','crm','client') NOT NULL DEFAULT 'admin'`
      );
      console.log('  + users.role ENUM now includes crm');
    } else {
      console.log('  = users.role already has crm');
    }
  }
  for (const tbl of ['feedback', 'task_comments']) {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = 'author_role' LIMIT 1`,
      [env.db.database, tbl]
    );
    if (col && !String(col.t).includes("'crm'")) {
      await query(
        `ALTER TABLE ${tbl} MODIFY COLUMN author_role
         ENUM('super_admin','admin','poster_designer','crm','client') DEFAULT NULL`
      );
      console.log(`  + ${tbl}.author_role ENUM now includes crm`);
    } else {
      console.log(`  = ${tbl}.author_role already has crm`);
    }
  }

  // Personal clients: excluded from NEW crm assignment (not retroactive).
  await addColumn('clients', 'is_personal', 'is_personal TINYINT(1) NOT NULL DEFAULT 0');

  // Reference links: an alternative to raw footage when none exists — CRM
  // pastes inspiration/reference URLs instead, so editing can still start.
  await addColumn('deliverables', 'reference_links', 'reference_links TEXT DEFAULT NULL');

  // Many-to-many: which CRM users can access which clients. Assigned from the
  // client's own edit page, super_admin only.
  await run('client_crm_access table', `
    CREATE TABLE IF NOT EXISTS client_crm_access (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      crm_user_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_client_crm (client_id, crm_user_id),
      KEY idx_cca_crm_user (crm_user_id),
      CONSTRAINT fk_cca_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_cca_crm_user FOREIGN KEY (crm_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---------------------------------------------------------------------
   * Cluster K — cloud video hosting (Cloudflare R2)
   * The finished video is uploaded straight from the browser to R2, so the
   * client streams it inline instead of being sent off to Google Drive.
   * ------------------------------------------------------------------- */

  // Public playable URL of the delivered video.
  await addColumn('deliverables', 'cloud_video_url', 'cloud_video_url VARCHAR(600) DEFAULT NULL');
  // Object key inside the bucket — kept so the file can be replaced/removed.
  await addColumn('deliverables', 'cloud_video_key', 'cloud_video_key VARCHAR(400) DEFAULT NULL');

  /* ---------------------------------------------------------------------
   * Cluster L — package split by service
   * A monthly package covers videos AND posters; one combined number
   * couldn't express "8 reels + 12 posters", so posters get their own target.
   * ------------------------------------------------------------------- */
  await addColumn(
    'clients',
    'monthly_posters',
    'monthly_posters INT UNSIGNED NOT NULL DEFAULT 0'
  );

  /* ---------------------------------------------------------------------
   * Cluster M — client tier
   * The monthly report groups clients by an A / B / C tier. Free text
   * rather than an enum: it's the agency's own label and they rename it.
   * ------------------------------------------------------------------- */
  await addColumn(
    'clients',
    'category',
    "category VARCHAR(10) NOT NULL DEFAULT ''"
  );

  /* ---------------------------------------------------------------------
   * Cluster N — Instagram auto-publishing (n8n)
   * An approved reel is picked up by an n8n workflow, pushed to the Meta
   * Graph API and reported back here. These columns are the handshake: the
   * workflow reads the queue, claims a row, and writes the outcome.
   * ------------------------------------------------------------------- */

  // Hashtags live apart from the caption so they can be regenerated, A/B'd and
  // reported on without rewriting the copy the client approved.
  await addColumn('deliverables', 'hashtags', 'hashtags TEXT DEFAULT NULL');

  // What Instagram gave us back — needed for insights, and for linking a
  // deliverable to the live post.
  await addColumn('deliverables', 'instagram_media_id', 'instagram_media_id VARCHAR(64) DEFAULT NULL');
  await addColumn('deliverables', 'instagram_permalink', 'instagram_permalink VARCHAR(500) DEFAULT NULL');
  await addColumn('deliverables', 'instagram_posted_at', 'instagram_posted_at DATETIME DEFAULT NULL');

  // Retry bookkeeping. `post_attempts` is the budget the publisher spends;
  // `post_error` is the last failure, surfaced in the UI so a human can see
  // why a post didn't go out without opening n8n.
  await addColumn('deliverables', 'post_attempts', 'post_attempts INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'post_error', 'post_error TEXT DEFAULT NULL');

  // Claim lease. Set when a run takes the row, cleared when it settles; a
  // stale lease is re-claimable so a crashed execution can't wedge the queue.
  await addColumn('deliverables', 'post_locked_at', 'post_locked_at DATETIME DEFAULT NULL');

  await addColumn('clients', 'ig_username', 'ig_username VARCHAR(100) DEFAULT NULL');
  // Optional per-client token; blank means "use the agency-wide one in n8n".
  await addColumn('clients', 'ig_access_token', 'ig_access_token TEXT DEFAULT NULL');
  await addColumn('clients', 'whatsapp_number', 'whatsapp_number VARCHAR(30) DEFAULT NULL');
  // Unattended posting is opt-in per client — never on by default.
  await addColumn('clients', 'auto_publish', 'auto_publish TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('clients', 'analytics_enabled', 'analytics_enabled TINYINT(1) NOT NULL DEFAULT 1');

  // Append-only audit trail of every publish attempt. Survives n8n's own
  // execution log, which expires.
  await run('publish_attempts table', `
    CREATE TABLE IF NOT EXISTS publish_attempts (
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
      KEY idx_pa_status (status),
      CONSTRAINT fk_pa_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---------------------------------------------------------------------
   * Cluster O — Instagram analytics history
   * A daily n8n job reads Instagram Insights and writes it here, so trends
   * can be charted over time instead of only ever showing "right now".
   * ------------------------------------------------------------------- */

  // Account-level metrics the original snapshot table didn't carry.
  await addColumn('analytics_snapshots', 'follower_delta', 'follower_delta BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'accounts_engaged', 'accounts_engaged BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'profile_visits', 'profile_visits BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'website_clicks', 'website_clicks BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'reel_plays', 'reel_plays BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'total_interactions', 'total_interactions BIGINT NOT NULL DEFAULT 0');
  await addColumn('analytics_snapshots', 'posts_count', 'posts_count INT UNSIGNED NOT NULL DEFAULT 0');

  // Per-media metrics, one row per media per day. Instagram serves lifetime
  // totals, so keeping the daily series is what makes deltas possible.
  await run('post_insights table', `
    CREATE TABLE IF NOT EXISTS post_insights (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      client_id      BIGINT UNSIGNED NOT NULL,
      platform       VARCHAR(30) NOT NULL DEFAULT 'instagram',
      media_id       VARCHAR(64) NOT NULL,
      media_type     VARCHAR(30) DEFAULT NULL,
      permalink      VARCHAR(500) DEFAULT NULL,
      thumbnail_url  VARCHAR(700) DEFAULT NULL,
      caption        TEXT DEFAULT NULL,
      published_at   DATETIME DEFAULT NULL,
      snapshot_date  DATE NOT NULL,
      reach          BIGINT NOT NULL DEFAULT 0,
      impressions    BIGINT NOT NULL DEFAULT 0,
      views          BIGINT NOT NULL DEFAULT 0,
      plays          BIGINT NOT NULL DEFAULT 0,
      likes          BIGINT NOT NULL DEFAULT 0,
      comments       BIGINT NOT NULL DEFAULT 0,
      shares         BIGINT NOT NULL DEFAULT 0,
      saves          BIGINT NOT NULL DEFAULT 0,
      total_interactions BIGINT NOT NULL DEFAULT 0,
      engagement_rate DECIMAL(7,2) NOT NULL DEFAULT 0.00,
      raw_json       JSON DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_post_insight (media_id, snapshot_date),
      KEY idx_pi_client_date (client_id, snapshot_date),
      KEY idx_pi_deliv (deliverable_id),
      KEY idx_pi_published (published_at),
      CONSTRAINT fk_pi_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_pi_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Cached LLM recommendations — one row per client per kind, refreshed daily.
  await run('ai_insights table', `
    CREATE TABLE IF NOT EXISTS ai_insights (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id    BIGINT UNSIGNED NOT NULL,
      platform     VARCHAR(30) NOT NULL DEFAULT 'instagram',
      kind         VARCHAR(40) NOT NULL,
      headline     VARCHAR(255) NOT NULL,
      detail       TEXT DEFAULT NULL,
      confidence   DECIMAL(4,2) NOT NULL DEFAULT 0.00,
      evidence_json JSON DEFAULT NULL,
      period_start DATE DEFAULT NULL,
      period_end   DATE DEFAULT NULL,
      generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ai_insight (client_id, platform, kind),
      KEY idx_ai_client (client_id),
      CONSTRAINT fk_ai_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Guards against emailing a client the same weekly/monthly report twice.
  await run('scheduled_reports table', `
    CREATE TABLE IF NOT EXISTS scheduled_reports (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id    BIGINT UNSIGNED NOT NULL,
      period       ENUM('weekly','monthly') NOT NULL,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      status       ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
      sent_to      VARCHAR(190) DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      summary_json JSON DEFAULT NULL,
      sent_at      DATETIME DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_report_period (client_id, period, period_start),
      KEY idx_sr_client (client_id),
      CONSTRAINT fk_sr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---------------------------------------------------------------------
   * Cluster P — WhatsApp approvals
   * The client approves the finished video in their own WhatsApp group by
   * replying "APPROVE V245" or "CHANGE V245 <notes>". A separate Express
   * service drives WhatsApp Web and calls back into the portal; these columns
   * and tables are that conversation's memory.
   * ------------------------------------------------------------------- */

  // Short human-typable handle for a deliverable. A client types this into
  // WhatsApp, so it has to be short and unambiguous — nobody is typing
  // "APPROVE 7f3a91c2-...". Unique, and never reused.
  await addColumn('deliverables', 'video_code', 'video_code VARCHAR(20) DEFAULT NULL');
  await addIndex(
    'deliverables',
    'uq_deliv_video_code',
    'UNIQUE KEY uq_deliv_video_code (video_code)'
  );

  // The WhatsApp conversation's own state, deliberately separate from the
  // portal's `status` column. A client can approve on WhatsApp while the task
  // is still mid-workflow internally, and collapsing the two would make one
  // overwrite the other.
  await addColumn(
    'deliverables',
    'wa_status',
    "wa_status VARCHAR(24) NOT NULL DEFAULT 'not_sent'"
  );
  await addColumn('deliverables', 'wa_group_id', 'wa_group_id VARCHAR(64) DEFAULT NULL');
  // whatsapp-web.js message id, so a delivery/read receipt can be matched back.
  await addColumn('deliverables', 'wa_message_id', 'wa_message_id VARCHAR(128) DEFAULT NULL');
  await addColumn('deliverables', 'wa_sent_at', 'wa_sent_at DATETIME DEFAULT NULL');
  await addColumn('deliverables', 'wa_delivered_at', 'wa_delivered_at DATETIME DEFAULT NULL');
  await addColumn('deliverables', 'wa_viewed_at', 'wa_viewed_at DATETIME DEFAULT NULL');
  await addColumn('deliverables', 'wa_responded_at', 'wa_responded_at DATETIME DEFAULT NULL');
  await addColumn('deliverables', 'wa_approved_by', 'wa_approved_by VARCHAR(150) DEFAULT NULL');
  await addColumn('deliverables', 'wa_approved_phone', 'wa_approved_phone VARCHAR(40) DEFAULT NULL');
  await addColumn('deliverables', 'wa_comment', 'wa_comment TEXT DEFAULT NULL');
  await addColumn('deliverables', 'wa_send_attempts', 'wa_send_attempts INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('deliverables', 'wa_last_error', 'wa_last_error TEXT DEFAULT NULL');

  // The WhatsApp message that produced the CURRENT verdict.
  //
  // This is the idempotency key for approvals, and it deliberately lives here
  // rather than being inferred from the transcript. WhatsApp redelivers
  // messages after a reconnect, so the same "APPROVE V245" arrives more than
  // once; but the transcript is written by a separate, best-effort call that
  // is allowed to fail. Keying replay-detection on the transcript therefore
  // gets it wrong in both directions — it misses replays when the log failed,
  // and (because the service logs before it approves) it treats the FIRST
  // approval as a replay when the log succeeded.
  await addColumn(
    'deliverables',
    'wa_approval_message_id',
    'wa_approval_message_id VARCHAR(128) DEFAULT NULL'
  );

  // Which WhatsApp group belongs to which client. A client can have more than
  // one (an internal group and a client-facing one), so the default is flagged
  // rather than assumed from a single column on `clients`.
  await run('whatsapp_groups table', `
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      group_id    VARCHAR(64) NOT NULL,      -- e.g. 12036304@g.us
      group_name  VARCHAR(190) DEFAULT NULL,
      is_default  TINYINT(1) NOT NULL DEFAULT 1,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- One row per group: the same group must never map to two clients, or an
      -- APPROVE reply becomes ambiguous.
      UNIQUE KEY uq_wa_group (group_id),
      KEY idx_wag_client (client_id),
      CONSTRAINT fk_wag_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Every inbound group message, whether or not it was a command. Kept in full
  // because "the client says they approved it" is a dispute that gets settled
  // by the transcript, not by the parsed result.
  await run('whatsapp_messages table', `
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
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
      -- What we made of it: approve | change | reject | unmatched | noise
      parsed_command VARCHAR(24) DEFAULT NULL,
      message_time   DATETIME NOT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- Idempotency: WhatsApp redelivers on reconnect, and a replayed message
      -- must not approve the same video twice.
      UNIQUE KEY uq_wa_msg (wa_message_id),
      KEY idx_wam_group (group_id),
      KEY idx_wam_deliv (deliverable_id),
      KEY idx_wam_time (message_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Outbound attempts: what we tried to send, whether it landed, and why not.
  await run('whatsapp_send_log table', `
    CREATE TABLE IF NOT EXISTS whatsapp_send_log (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Health of the WhatsApp session itself — one row, updated in place. Lets
  // the portal show "connected / disconnected" without holding a socket open
  // to the service, which a serverless deployment cannot do.
  await run('whatsapp_session table', `
    CREATE TABLE IF NOT EXISTS whatsapp_session (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* ---------------------------------------------------------------------
   * Cluster Q — AI video analysis
   * When an editor uploads a finished video, Gemini watches it and writes a
   * caption from what it actually saw and heard, rather than from the brief
   * someone typed weeks earlier.
   * ------------------------------------------------------------------- */

  // One row per deliverable, holding the job as well as the result.
  //
  // It has to be a job, not a plain result: analysing a 66 MB video takes
  // ~30 seconds across four steps (fetch from R2, upload to Gemini, wait for
  // processing, generate), and a serverless function can be killed partway.
  // Recording which step succeeded means a retry resumes instead of paying
  // for the upload twice.
  await run('video_analysis table', `
    CREATE TABLE IF NOT EXISTS video_analysis (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      -- queued → uploading → processing → analysing → done | failed
      state          VARCHAR(24) NOT NULL DEFAULT 'queued',
      -- Gemini's handle for the uploaded file. Present once the upload has
      -- succeeded, which is what makes a resume cheap.
      file_uri       VARCHAR(500) DEFAULT NULL,
      file_name      VARCHAR(255) DEFAULT NULL,
      file_expires_at DATETIME DEFAULT NULL,
      model          VARCHAR(60) DEFAULT NULL,
      -- What the model understood: summary, language, on-screen text, scenes.
      summary        TEXT DEFAULT NULL,
      spoken_language VARCHAR(40) DEFAULT NULL,
      topic          VARCHAR(190) DEFAULT NULL,
      mood           VARCHAR(60) DEFAULT NULL,
      on_screen_text TEXT DEFAULT NULL,
      scenes_json    JSON DEFAULT NULL,
      -- What it wrote. Kept apart from deliverables.caption so a regenerated
      -- draft never silently overwrites copy a human has edited.
      caption        TEXT DEFAULT NULL,
      hook           TEXT DEFAULT NULL,
      hashtags       TEXT DEFAULT NULL,
      raw_json       JSON DEFAULT NULL,
      video_bytes    BIGINT UNSIGNED DEFAULT NULL,
      tokens_used    INT UNSIGNED DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      attempts       INT UNSIGNED NOT NULL DEFAULT 0,
      last_error     TEXT DEFAULT NULL,
      -- Lease, same idea as the publish claim: a job whose lease has expired
      -- was killed mid-run and may be picked up again.
      locked_at      DATETIME DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- One analysis per deliverable; a rewrite updates in place.
      UNIQUE KEY uq_va_deliv (deliverable_id),
      KEY idx_va_state (state),
      CONSTRAINT fk_va_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // What branding the AI actually spotted in the frame (logo text, watermark,
  // footer bar, phone, website, handle) and what business context it was given.
  // Both stored so a caption that reads oddly can be traced to its inputs
  // rather than re-run and guessed at.
  await addColumn('video_analysis', 'brand_seen', 'brand_seen TEXT DEFAULT NULL');
  await addColumn('video_analysis', 'context_used', 'context_used TEXT DEFAULT NULL');
  await addColumn('video_analysis', 'grounded', 'grounded TINYINT(1) NOT NULL DEFAULT 0');

  /* ---- Cluster R: 'video_editor' team role ---- */
  for (const spec of [
    {
      table: 'users',
      column: 'role',
      definition: `ENUM('super_admin','admin','poster_designer','video_editor','crm','client') NOT NULL DEFAULT 'admin'`,
    },
    // Comments and feedback stamp the author's role, so an editor leaving a
    // note would otherwise be truncated to an empty string.
    {
      table: 'feedback',
      column: 'author_role',
      definition: `ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL`,
    },
    {
      table: 'task_comments',
      column: 'author_role',
      definition: `ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL`,
    },
  ]) {
    const [col] = await query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
      [env.db.database, spec.table, spec.column]
    );
    if (!col) {
      console.log(`  = ${spec.table}.${spec.column} not present, skipping`);
    } else if (String(col.t).includes("'video_editor'")) {
      console.log(`  = ${spec.table}.${spec.column} already has video_editor`);
    } else {
      await query(`ALTER TABLE ${spec.table} MODIFY COLUMN ${spec.column} ${spec.definition}`);
      console.log(`  + ${spec.table}.${spec.column} now includes video_editor`);
    }
  }

  // Which video the cached Gemini upload was made from.
  //
  // Without it, replacing a task's video left the old upload in place and the
  // AI kept captioning the file it already held — a caption with no relation
  // to the video on screen, and no way to clear it short of waiting 40 hours
  // for Google to expire the file.
  await addColumn('video_analysis', 'source_ref', 'source_ref VARCHAR(600) DEFAULT NULL');

  // Existing rows describe whatever video the task points at now. Saying so
  // explicitly stops the first run after this migration from treating every
  // analysis as stale and re-doing all of them.
  await run('backfill video_analysis.source_ref', `
    UPDATE video_analysis v
      JOIN deliverables d ON d.id = v.deliverable_id
       SET v.source_ref = COALESCE(d.cloud_video_key, d.cloud_video_url, d.edited_link)
     WHERE v.source_ref IS NULL`);

  console.log('✔ Migrations complete.');
  await getPool().end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
