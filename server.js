/**
 * Agency ERP + CRM + Client Portal — application entry point.
 * Express app with security hardening, static frontend, and modular API.
 */
'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const db = require('./src/config/db');
const apiRouter = require('./src/routes');
const { notFound, errorHandler } = require('./src/middleware/errorHandler');
const scheduler = require('./src/services/schedulerService');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- Security & platform middleware ---------- */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Allow the Razorpay checkout script + Google fonts + Drive thumbnails.
        'script-src': ["'self'", 'https://checkout.razorpay.com', 'https://unpkg.com'],
        'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://drive.google.com'],
        'img-src': ["'self'", 'data:', 'https:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'connect-src': ["'self'", 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors({ origin: env.security.corsOrigin === '*' ? true : env.security.corsOrigin.split(','), credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
if (!env.isProd) app.use(morgan('dev'));

/* Global API rate limit (login has its own stricter limiter). */
app.use(
  '/api',
  rateLimit({
    windowMs: env.security.rateLimitWindowMs,
    max: env.security.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests — slow down.' },
  })
);

/* ---------- API ---------- */
app.get('/api/health', async (req, res) => {
  const dbOk = await db.healthCheck();
  res.status(dbOk ? 200 : 503).json({ success: dbOk, db: dbOk, uptime: process.uptime() });
});
app.use('/api', apiRouter);

/* ---------- Static frontend ---------- */
// In development, never let the browser serve stale HTML/JS/CSS from cache.
if (!env.isProd) {
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
}
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: env.isProd ? '1d' : 0,
  index: 'index.html',
  etag: true,
  // In development, never serve stale JS/CSS from the browser cache.
  setHeaders: (res) => { if (!env.isProd) res.setHeader('Cache-Control', 'no-store'); },
}));

// SPA-ish fallbacks for the two app shells.
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'portal.html')));

/* ---------- Errors ---------- */
app.use('/api', notFound);
app.use(errorHandler);

/* ---------- Boot ---------- */
async function start() {
  const dbOk = await db.healthCheck();
  if (!dbOk) {
    logger.error('Cannot reach MySQL. Check .env DB settings, then run: npm run db:setup && npm run db:seed');
  }
  app.listen(env.port, () => {
    logger.info(`${env.appName} running at ${env.appUrl} (${env.nodeEnv})`);
    logger.info(`Integrations — OpenAI: ${env.openai.enabled ? 'LIVE' : 'demo'}, Razorpay: ${env.razorpay.enabled ? 'LIVE' : 'demo'}, Meta: ${env.meta.enabled ? 'LIVE' : 'demo'}, SMTP: ${env.mail.enabled ? 'LIVE' : 'off'}`);
    scheduler.start();
  });
}

start();

module.exports = app;
