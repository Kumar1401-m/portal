/**
 * Lightweight in-process scheduler (no external deps).
 * Jobs:
 *   - hourly : task-due notifications for deliverables due today
 *   - hourly : payment reminders for overdue invoices
 *   - daily  : database backup via mysqldump (backups/ folder)
 *   - daily  : Meta analytics sync (when configured)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger');
const { query } = require('../config/db');
const { notifyAdmins, notifyClient } = require('./notificationService');
const metaService = require('./metaService');
const youtubeService = require('./youtubeService');

const BACKUP_DIR = path.resolve(__dirname, '../../backups');

/** Run mysqldump to a timestamped .sql file; keep the last 14 backups. */
function runBackup() {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(BACKUP_DIR, `backup-${stamp}.sql`);
      const args = [
        `-h${env.db.host}`, `-P${env.db.port}`, `-u${env.db.user}`,
      ];
      if (env.db.password) args.push(`-p${env.db.password}`);
      args.push('--single-transaction', '--routines', env.db.database);

      const out = fs.createWriteStream(file);
      const proc = spawn('mysqldump', args, { windowsHide: true });
      proc.stdout.pipe(out);
      proc.on('error', (err) => {
        logger.warn('Backup skipped (mysqldump not found):', err.message);
        resolve(false);
      });
      proc.on('close', (code) => {
        if (code === 0) {
          logger.info('Database backup written:', file);
          // Retention: keep newest 14
          const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sql')).sort();
          while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
          resolve(true);
        } else {
          logger.warn('Backup failed with exit code', code);
          resolve(false);
        }
      });
    } catch (err) {
      logger.warn('Backup error:', err.message);
      resolve(false);
    }
  });
}

/** Notify admins about deliverables due today that are not finished. */
async function notifyDueTasks() {
  const rows = await query(
    `SELECT d.id, d.title, c.company_name FROM deliverables d
     JOIN clients c ON c.id = d.client_id
     WHERE d.due_date = CURDATE()
       AND d.status NOT IN ('posted','completed','cancelled','rejected')`
  );
  if (rows.length) {
    await notifyAdmins(
      'task_due',
      `${rows.length} task(s) due today`,
      rows.slice(0, 5).map((r) => `${r.company_name}: ${r.title}`).join(' · '),
      '#/deliverables?due=today'
    );
  }
}

/** Remind clients about pending/overdue invoices. */
async function notifyPendingPayments() {
  const rows = await query(
    `SELECT i.id, i.invoice_no, i.total, i.client_id, c.company_name
     FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.status IN ('sent','overdue') AND i.due_date IS NOT NULL AND i.due_date < CURDATE()`
  );
  for (const inv of rows) {
    await query("UPDATE invoices SET status='overdue' WHERE id = ? AND status='sent'", [inv.id]);
    await notifyClient(
      inv.client_id,
      'payment_pending',
      `Invoice ${inv.invoice_no} is overdue`,
      `Amount due: ₹${Number(inv.total).toLocaleString('en-IN')}. Please complete payment from your portal.`,
      '#/payments'
    );
  }
  if (rows.length) {
    await notifyAdmins('payment_pending', `${rows.length} overdue invoice(s)`, 'Auto reminders sent to clients.', '#/payments');
  }
}

/** Start all timers. Daily jobs fire on first tick after 02:00 local time. */
function start() {
  let lastDailyRun = null;

  // Hourly notifications
  setInterval(() => {
    notifyDueTasks().catch((e) => logger.warn('due-task job failed:', e.message));
    notifyPendingPayments().catch((e) => logger.warn('payment-reminder job failed:', e.message));
  }, 60 * 60 * 1000);

  // Daily jobs — check every 10 minutes whether we've crossed 02:00
  setInterval(async () => {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getHours() >= 2 && lastDailyRun !== dayKey) {
      lastDailyRun = dayKey;
      await runBackup();
      const meta = await metaService.syncAll();
      if (meta.live) logger.info(`Meta sync complete (${meta.synced} clients).`);
      const yt = await youtubeService.syncAll();
      if (yt.live) logger.info(`YouTube sync complete (${yt.synced} clients).`);
    }
  }, 10 * 60 * 1000);

  logger.info('Scheduler started (hourly reminders, daily 02:00 backup + analytics sync).');
}

module.exports = { start, runBackup, notifyDueTasks, notifyPendingPayments };
