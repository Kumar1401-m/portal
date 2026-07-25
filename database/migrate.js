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

  console.log('✔ Migrations complete.');
  await getPool().end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
