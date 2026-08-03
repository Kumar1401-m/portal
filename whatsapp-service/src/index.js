'use strict';

/**
 * WhatsApp approval service.
 *
 * A small Express app that owns one WhatsApp Web session and does three jobs:
 *
 *   1. Sends approval videos into client groups when the portal asks.
 *   2. Watches those groups for APPROVE / CHANGE replies and reports them back.
 *   3. Hosts the Socket.IO hub the portal dashboard connects to.
 *
 * (3) deserves a note. The portal runs on Vercel, where functions are torn
 * down between requests and cannot hold a WebSocket open — so Socket.IO cannot
 * live there. This process is long-lived by necessity (it drives a browser),
 * which makes it the natural home for realtime. The dashboard connects here as
 * a client.
 *
 * Deliberately holds no database. The portal is the system of record; this
 * service is a transport that happens to be stateful about one browser session.
 */
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server: SocketServer } = require('socket.io');

const { config, assertConfig } = require('./config');
const { createLogger } = require('./lib/logger');
const { WhatsAppService } = require('./lib/whatsapp-client');
const { SendQueue } = require('./lib/send-queue');
const { MessageRouter } = require('./lib/message-router');
const { reportSession } = require('./lib/portal-client');
const { buildRoutes } = require('./routes');

const log = createLogger('server');

assertConfig();

const app = express();
const server = http.createServer(app);

/* --------------------------------- Security -------------------------------- */

// No browser ever renders from this service — it serves JSON and one QR image.
// CSP defaults would be pointless here; the headers that matter are the ones
// stopping content sniffing and framing.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(
  cors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
  })
);

// Generous, because a video payload is a URL and not the file itself.
app.use(express.json({ limit: '1mb' }));

/**
 * Rate limiting. The portal is the only legitimate caller and it makes a
 * handful of requests per approval, so this is set to catch a runaway loop or
 * a leaked key rather than to shape normal traffic.
 */
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests' },
  })
);

/* ------------------------------- Composition ------------------------------- */

const io = new SocketServer(server, {
  cors: {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
  },
  path: '/socket.io',
});

const whatsapp = new WhatsAppService();
const sendQueue = new SendQueue(whatsapp, io);
const router = new MessageRouter(whatsapp, io);

/* ------------------------------ Event plumbing ----------------------------- */

whatsapp.on('message', (msg) => {
  router.handle(msg).catch((err) => log.error('router failed', { error: err.message }));
});

whatsapp.on('state', (status) => {
  io.emit('whatsappStatus', status);
  // Mirrored into the portal's database so the settings page can show health
  // without holding a socket open — which a serverless page cannot do.
  reportSession({
    state: status.state,
    phoneNumber: status.me?.number ?? null,
    pushName: status.me?.pushName ?? null,
    qrAvailable: status.qrAvailable,
    lastError: status.lastError,
    lastReadyAt: status.lastReadyAt,
  }).catch(() => {});
});

whatsapp.on('qr', ({ dataUrl }) => io.emit('whatsappQr', { dataUrl }));

whatsapp.on('ack', ({ messageId, ack }) => {
  // whatsapp-web.js ack levels: 1 sent to server, 2 delivered, 3 read.
  const status = ack >= 3 ? 'read' : ack === 2 ? 'delivered' : null;
  if (!status || !messageId) return;
  io.emit('videoDelivery', { waMessageId: messageId, status });
  require('./lib/portal-client')
    .reportSendStatus({ waMessageId: messageId, status })
    .catch(() => {});
});

io.on('connection', (socket) => {
  log.debug('dashboard connected', { id: socket.id });
  // Push current state immediately, so a dashboard opened mid-session isn't
  // blank until something happens to change.
  socket.emit('whatsappStatus', whatsapp.status());
  socket.on('disconnect', () => log.debug('dashboard disconnected', { id: socket.id }));
});

/* --------------------------------- Routes --------------------------------- */

app.use('/', buildRoutes({ whatsapp, sendQueue, io }));

// Anything unmatched. JSON, not Express's HTML page — every caller here is a
// machine.
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.use((err, _req, res, _next) => {
  log.error('unhandled error', { error: err.message, stack: err.stack?.split('\n')[1]?.trim() });
  res.status(500).json({ ok: false, error: 'Internal error' });
});

/* --------------------------------- Startup -------------------------------- */

server.listen(config.port, () => {
  log.info(`listening on :${config.port}`, {
    portal: config.portal.url,
    env: config.nodeEnv,
  });
  whatsapp.start().catch((err) => log.error('startup failed', { error: err.message }));
});

/**
 * Heartbeat. The portal shows "last seen" from this, so a service that has
 * silently died is visibly stale rather than indistinguishable from an idle one.
 */
const heartbeat = setInterval(() => {
  reportSession({ ...whatsapp.status(), heartbeat: true }).catch(() => {});
}, 60_000);

/** Close the browser cleanly, or the session lock is left behind. */
async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  clearInterval(heartbeat);
  server.close();
  io.close();
  await whatsapp.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Puppeteer throws from places that aren't awaited. Logging and staying up
// beats dying: a rejected promise deep in the browser driver is usually
// recoverable, and the reconnect logic handles the cases that aren't.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: reason?.message || String(reason) });
});
