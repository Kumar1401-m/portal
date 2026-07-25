/**
 * Centralised environment configuration.
 * Loads .env once and exposes a typed, validated config object so the rest of
 * the app never touches process.env directly.
 */
'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const toInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
};
const toBool = (val, fallback = false) => {
  if (val === undefined) return fallback;
  return String(val).toLowerCase() === 'true';
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: toInt(process.env.PORT, 4000),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  appName: process.env.APP_NAME || 'Agency ERP',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agency_erp',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    accessSecret: process.env.JWT_SECRET || 'dev_access_secret_change_me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),

  superAdmin: {
    name: process.env.SUPERADMIN_NAME || 'Super Admin',
    email: process.env.SUPERADMIN_EMAIL || 'admin@agency.com',
    password: process.env.SUPERADMIN_PASSWORD || 'Admin@12345',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    enabled: Boolean(process.env.OPENAI_API_KEY),
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    enabled: Boolean(process.env.GEMINI_API_KEY),
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    enabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  },

  meta: {
    token: process.env.META_GRAPH_TOKEN || '',
    version: process.env.META_GRAPH_VERSION || 'v21.0',
    enabled: Boolean(process.env.META_GRAPH_TOKEN),
  },

  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
    enabled: Boolean(process.env.YOUTUBE_API_KEY),
  },

  google: {
    driveApiKey: process.env.GOOGLE_DRIVE_API_KEY || '',
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    enabled: Boolean(process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_CLIENT_ID),
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    secure: toBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Agency ERP <no-reply@agency.com>',
    enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
  },

  security: {
    rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 300),
    corsOrigin: process.env.CORS_ORIGIN || '*',
  },
};

module.exports = env;
