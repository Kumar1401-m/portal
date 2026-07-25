/**
 * Notification service: writes in-app notifications and (optionally) mirrors
 * them by email. All functions are fire-and-forget safe.
 */
'use strict';

const { query } = require('../config/db');
const { sendNotificationEmail } = require('./emailService');
const logger = require('../utils/logger');

/**
 * Notify a single user.
 * @param {number} userId
 * @param {string} type    one of NOTIFICATION_TYPES
 * @param {string} title
 * @param {string} body
 * @param {string} [link]  in-app link (e.g. '#/deliverables/12')
 * @param {string} [email] if provided, also send an email copy
 */
async function notifyUser(userId, type, title, body, link = null, email = null) {
  try {
    await query(
      'INSERT INTO notifications (user_id, type, title, body, link) VALUES (?,?,?,?,?)',
      [userId, type, title, body, link]
    );
    if (email) {
      // Email is best-effort; do not await failures into the caller.
      // Branded notification email with a "View in portal" button (deep link).
      sendNotificationEmail(email, title, title, body, link).catch(() => {});
    }
  } catch (err) {
    logger.warn('notifyUser failed:', err.message);
  }
}

/** Notify every active admin + super admin. */
async function notifyAdmins(type, title, body, link = null) {
  try {
    const admins = await query(
      "SELECT id, email FROM users WHERE role IN ('admin','super_admin') AND is_active = 1"
    );
    await Promise.all(admins.map((a) => notifyUser(a.id, type, title, body, link, a.email)));
  } catch (err) {
    logger.warn('notifyAdmins failed:', err.message);
  }
}

/**
 * Notify the login user attached to a client record.
 * Pass `mail = false` when the caller will send its own (formal) email, so the
 * client doesn't receive a duplicate generic copy.
 */
async function notifyClient(clientId, type, title, body, link = null, mail = true) {
  try {
    const rows = await query(
      `SELECT u.id, u.email FROM clients c JOIN users u ON u.id = c.user_id
       WHERE c.id = ? AND u.is_active = 1`,
      [clientId]
    );
    if (rows.length) await notifyUser(rows[0].id, type, title, body, link, mail ? rows[0].email : null);
  } catch (err) {
    logger.warn('notifyClient failed:', err.message);
  }
}

module.exports = { notifyUser, notifyAdmins, notifyClient };
