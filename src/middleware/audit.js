/**
 * Audit logging helper — call `audit(req, action, entityType, entityId, description, meta)`
 * from any handler after a meaningful mutation. Fire-and-forget (never blocks
 * the response, never throws).
 */
'use strict';

const { query } = require('../config/db');
const logger = require('../utils/logger');

async function audit(req, action, entityType = null, entityId = null, description = null, meta = null) {
  try {
    await query(
      `INSERT INTO activity_logs (user_id, actor_name, action, entity_type, entity_id, description, meta_json, ip_address)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        req.user ? req.user.id : null,
        req.user ? req.user.name : 'system',
        action,
        entityType,
        entityId,
        description,
        meta ? JSON.stringify(meta) : null,
        req.ip || null,
      ]
    );
  } catch (err) {
    logger.warn('Audit log failed:', err.message);
  }
}

module.exports = audit;
