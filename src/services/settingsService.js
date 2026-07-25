/**
 * Agency settings service — key/value config stored in the `settings` table,
 * cached in memory. Sensitive keys (Razorpay secret) are never returned to the
 * frontend in full; use getEffective*() helpers server-side.
 *
 * DB settings take precedence over .env, so the agency can configure Razorpay,
 * branding, invoice prefix and the processing fee entirely from the UI.
 */
'use strict';

const env = require('./../config/env');
const { query } = require('../config/db');
const logger = require('../utils/logger');

const DEFAULTS = {
  company_name: env.appName,
  powered_by: 'Powered by Venkat',
  company_logo_url: '',
  contact_number: '',
  company_email: env.mail.from || '',
  business_address: '',
  razorpay_key_id: '',
  razorpay_key_secret: '',
  invoice_prefix: 'INV',
  processing_fee_percent: '2.60',
  tax_percent: '0',
};

// Keys that must never be sent to the browser.
const SECRET_KEYS = ['razorpay_key_secret'];

let cache = null;

/** Load all settings into cache (merged over defaults). */
async function load(force = false) {
  if (cache && !force) return cache;
  const merged = { ...DEFAULTS };
  try {
    const rows = await query('SELECT setting_key, setting_value FROM settings');
    rows.forEach((r) => { merged[r.setting_key] = r.setting_value; });
  } catch (err) {
    logger.warn('settings load failed, using defaults:', err.message);
  }
  cache = merged;
  return cache;
}

/** Get a single setting value (string). */
async function get(key) {
  const all = await load();
  return all[key];
}

/** Public settings for the frontend — secrets masked to a boolean "is set". */
async function getPublic() {
  const all = await load();
  const out = { ...all };
  SECRET_KEYS.forEach((k) => {
    out[`${k}_set`] = Boolean(all[k]);
    delete out[k];
  });
  return out;
}

/** Persist a batch of settings, then refresh the cache. */
async function setMany(obj) {
  const entries = Object.entries(obj).filter(([k]) => k in DEFAULTS);
  for (const [k, v] of entries) {
    await query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?,?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [k, v == null ? '' : String(v)]
    );
  }
  await load(true);
  return cache;
}

/** Effective Razorpay credentials (DB first, then .env). */
async function getRazorpayConfig() {
  const all = await load();
  const keyId = all.razorpay_key_id || env.razorpay.keyId;
  const keySecret = all.razorpay_key_secret || env.razorpay.keySecret;
  return { keyId, keySecret, enabled: Boolean(keyId && keySecret) };
}

/** Processing fee percentage as a number (e.g. 2.6). */
async function getProcessingFeePercent() {
  const v = parseFloat(await get('processing_fee_percent'));
  return Number.isFinite(v) ? v : 0;
}

module.exports = {
  load, get, getPublic, setMany, getRazorpayConfig, getProcessingFeePercent, DEFAULTS, SECRET_KEYS,
};
