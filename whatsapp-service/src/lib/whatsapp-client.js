'use strict';

/**
 * The WhatsApp Web session.
 *
 * Wraps whatsapp-web.js so the rest of the service never touches it directly:
 * everything else asks this module for state or hands it a job. That matters
 * because whatsapp-web.js is an unofficial library driving a real browser, and
 * it fails in ways a normal SDK does not — the page can hang, the session can
 * be invalidated from the phone, Chromium can die. Containing that here keeps
 * the failure modes in one file.
 *
 * Design notes:
 *
 *   - LocalAuth persists the session to disk, so a restart does NOT require a
 *     new QR scan. In Docker that path must be a volume; losing it is silent
 *     downtime until someone notices approvals went unanswered.
 *   - Reconnection is automatic with backoff, capped. An endless tight retry
 *     against a banned number is how you turn a problem into a worse one.
 *   - Only GROUP messages are handled. Personal chats are ignored entirely and
 *     never leave this process — an agency phone gets personal messages, and
 *     they are none of the portal's business.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('whatsapp');

/**
 * Errors that describe the browser being torn down, not a problem to act on.
 *
 * whatsapp-web.js drives a real Chromium, and closing it mid-call throws from
 * whichever call was in flight. Every one of these is a symptom of a shutdown
 * that already had a cause — a logout, a reconnect — and recording one as the
 * session's last error displaces the cause with its own echo.
 *
 * The visible damage was on the settings page: a session sitting healthily at
 * "scan the QR" showed "Protocol error (Runtime.callFunctionOn): Target
 * closed" in red, so the one screen that exists to say what to do next said
 * something alarming and unactionable instead.
 */
const TEARDOWN_NOISE =
  /target closed|protocol error|detached frame|session closed|execution context was destroyed|browser has disconnected/i;

/** Connection states surfaced to the portal and the settings UI. */
const STATE = {
  BOOTING: 'booting',
  QR: 'qr_required',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
};

/**
 * Remove the lock Chromium leaves behind when it is killed rather than closed.
 *
 * Chromium writes a SingletonLock into the profile naming the process and host
 * holding it, and refuses to start if it finds one. That is the right
 * behaviour on a desktop, where a second Chromium really could corrupt the
 * profile. In a container it is a trap: replacing the container kills Chromium
 * without warning, the lock survives in the session volume, and the next
 * container refuses to start — reporting a process on "another computer" that
 * is really the container it just replaced.
 *
 * Safe to do unconditionally at startup. This process is the only thing in
 * this container, and nothing else can be holding the profile: if another
 * container were somehow sharing the volume, the two would already be
 * fighting over the same WhatsApp session, which is a worse problem than a
 * lock file.
 *
 * The alternative — telling someone to delete three files over SSH every time
 * the service is rebuilt — is not an alternative.
 */
function clearStaleProfileLock() {
  const root = path.resolve(config.whatsapp.sessionPath);
  let removed = 0;
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(root, dir.name, name);
        try {
          fs.rmSync(p, { force: true });
          if (fs.existsSync(p) === false) removed++;
        } catch {
          /* not there, or not ours to remove — Chromium will say so itself */
        }
      }
    }
  } catch {
    // No session directory yet: a first run, which has nothing to unlock.
    return;
  }
  if (removed) log.info('cleared a stale Chromium profile lock', { removed });
}

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = STATE.BOOTING;
    /** Latest QR as a data URL, or null once authenticated. */
    this.qrDataUrl = null;
    this.qrGeneratedAt = null;
    this.me = null;
    this.lastError = null;
    this.lastReadyAt = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.destroyed = false;
    /** Serialises sends — see `enqueueSend`. */
    this.sendChain = Promise.resolve();
  }

  /* ---------------------------- Lifecycle ---------------------------- */

  async start() {
    if (this.client) {
      log.warn('start() called with a client already running — ignoring');
      return;
    }

    this.setState(STATE.BOOTING);
    log.info('starting WhatsApp client', {
      sessionPath: config.whatsapp.sessionPath,
      clientId: config.whatsapp.clientId,
    });

    clearStaleProfileLock();

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: config.whatsapp.clientId,
        dataPath: path.resolve(config.whatsapp.sessionPath),
      }),
      puppeteer: {
        headless: config.whatsapp.headless,
        executablePath: config.whatsapp.executablePath,
        // Required in a container: Chromium's sandbox needs kernel
        // capabilities Docker withholds by default, and /dev/shm is 64 MB
        // there, which Chromium exhausts and then crashes on a large page.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          /*
           * Everything below exists to keep Chromium inside a 2 GB container
           * on a 1 vCPU box that is also running n8n. Syncing a real WhatsApp
           * account is the heaviest moment, and being killed during it means
           * restarting and syncing again — a loop, not a crash.
           *
           * None of these change what WhatsApp Web can do. They switch off
           * work that only matters on a desktop with a screen and a user.
           */
          '--renderer-process-limit=1',
          '--js-flags=--max-old-space-size=512',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
          '--mute-audio',
          '--metrics-recording-only',
        ],
      },
      // Pin the web version cache so a WhatsApp Web update doesn't break the
      // library mid-week without warning.
      webVersionCache: { type: 'local' },
    });

    this.registerHandlers();

    try {
      await this.client.initialize();
    } catch (err) {
      this.noteError(err.message);
      log.error('initialize failed', { error: err.message });
      this.setState(STATE.FAILED);
      this.scheduleReconnect();
    }
  }

  /**
   * Record a failure, unless it is the browser closing.
   *
   * Kept in one place so every path that sets an error goes through the same
   * filter — and so a genuine failure is never lost to it: noise is only
   * dropped, never allowed to overwrite a real reason that is already there.
   */
  noteError(message) {
    const text = message ? String(message) : null;
    if (!text) return;
    if (TEARDOWN_NOISE.test(text)) {
      log.debug('ignoring a browser teardown error', { error: text });
      return;
    }
    this.lastError = text;
  }

  registerHandlers() {
    const c = this.client;

    c.on('qr', async (qr) => {
      // Rendered to a data URL here rather than shipped raw: the settings page
      // shows an <img>, and making the browser depend on a QR library for a
      // once-a-month operation isn't worth the bundle.
      try {
        this.qrDataUrl = await qrcode.toDataURL(qr, { width: 320, margin: 2 });
        this.qrGeneratedAt = new Date();
        /*
         * A QR means the browser is up and WhatsApp Web is asking to be logged
         * in — the session is healthy and waiting on a person, which is not a
         * failure state. Whatever went wrong before this is history, and
         * leaving it on screen tells someone to fix something instead of
         * telling them to scan.
         */
        this.lastError = null;
        this.setState(STATE.QR);
        log.warn('QR code required — scan it from the WhatsApp app to log in');
        this.emit('qr', { dataUrl: this.qrDataUrl });
      } catch (err) {
        log.error('could not render QR', { error: err.message });
      }
    });

    c.on('authenticated', () => {
      this.qrDataUrl = null;
      this.setState(STATE.AUTHENTICATING);
      log.info('authenticated — session saved to disk');
    });

    c.on('auth_failure', (message) => {
      this.noteError(message);
      this.setState(STATE.FAILED);
      log.error('authentication failed — the saved session is no longer valid', { message });
      this.emit('auth_failure', { message });
    });

    c.on('ready', async () => {
      this.qrDataUrl = null;
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.lastReadyAt = new Date();
      try {
        this.me = {
          number: c.info?.wid?.user ?? null,
          pushName: c.info?.pushname ?? null,
          platform: c.info?.platform ?? null,
        };
      } catch {
        this.me = null;
      }
      this.setState(STATE.CONNECTED);
      log.info('connected', this.me || {});
      this.emit('ready', this.me);
    });

    c.on('disconnected', (reason) => {
      this.noteError(reason);
      this.setState(STATE.DISCONNECTED);
      log.warn('disconnected', { reason });
      this.emit('disconnected', { reason });
      // The client is unusable after this event; tear it down before retrying
      // or the next initialize() attaches to a dead browser.
      this.teardownClient().finally(() => this.scheduleReconnect());
    });

    c.on('change_state', (state) => log.debug('internal state change', { state }));

    // Inbound. `message` fires for others' messages; `message_create` would
    // also fire for our own, which would make the service react to itself.
    c.on('message', (message) => {
      this.handleIncoming(message).catch((err) =>
        log.error('inbound handler threw', { error: err.message })
      );
    });

    // Delivery receipts: ack 2 = delivered to device, 3 = read.
    c.on('message_ack', (message, ack) => {
      if (!message.fromMe) return;
      this.emit('ack', { messageId: message.id?._serialized ?? null, ack });
    });
  }

  async teardownClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.destroy();
    } catch (err) {
      log.debug('destroy during teardown failed (usually harmless)', { error: err.message });
    }
  }

  /**
   * Reconnect with exponential backoff, capped at 10 minutes and 20 tries.
   *
   * The cap is the point: if WhatsApp has invalidated or banned the session,
   * retrying every few seconds forever achieves nothing and looks exactly like
   * the abusive behaviour that gets a number banned in the first place. After
   * the cap the service stays up and reports `failed`, so the portal can show
   * "reconnect" and a human can decide.
   */
  scheduleReconnect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;

    const MAX_ATTEMPTS = 20;
    if (this.reconnectAttempts >= MAX_ATTEMPTS) {
      log.error('giving up automatic reconnection — use the Reconnect button', {
        attempts: this.reconnectAttempts,
      });
      this.setState(STATE.FAILED);
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(5000 * 2 ** (this.reconnectAttempts - 1), 10 * 60 * 1000);
    log.info('scheduling reconnect', { attempt: this.reconnectAttempts, inMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => log.error('reconnect failed', { error: err.message }));
    }, delay);
  }

  /** Operator-triggered reconnect: resets the budget and starts immediately. */
  async reconnect() {
    log.info('manual reconnect requested');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    await this.teardownClient();
    await this.start();
  }

  /** Log out and delete the session — forces a fresh QR scan. */
  async logout() {
    log.warn('logging out — the next start will require a QR scan');
    try {
      if (this.client) await this.client.logout();
    } catch (err) {
      log.warn('logout call failed; tearing down anyway', { error: err.message });
    }
    await this.teardownClient();
    this.me = null;
    this.setState(STATE.DISCONNECTED);
  }

  async shutdown() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.teardownClient();
  }

  setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    log.info('state', { from: previous, to: state });
    this.emit('state', this.status());
  }

  status() {
    return {
      state: this.state,
      connected: this.state === STATE.CONNECTED,
      qrAvailable: Boolean(this.qrDataUrl),
      qrGeneratedAt: this.qrGeneratedAt,
      me: this.me,
      lastError: this.lastError,
      lastReadyAt: this.lastReadyAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /* ------------------------------- Inbound ------------------------------- */

  /**
   * Handle one inbound message.
   *
   * Filters hard and early. Anything that isn't a group message is dropped
   * before it is read, let alone forwarded — the agency's phone receives
   * personal messages and none of them belong in a client portal's database.
   */
  async handleIncoming(message) {
    const chatId = message.from || '';
    // Group ids always end @g.us; personal chats end @c.us.
    if (!chatId.endsWith('@g.us')) return;

    if (
      config.whatsapp.allowedGroups.length &&
      !config.whatsapp.allowedGroups.includes(chatId)
    ) {
      log.debug('ignoring message from a group not on the allow-list', { chatId });
      return;
    }

    let groupName = null;
    try {
      const chat = await message.getChat();
      groupName = chat?.name ?? null;
    } catch {
      // Not fatal — the portal matches on group id, the name is decoration.
    }

    let senderName = null;
    let senderNumber = null;
    try {
      const contact = await message.getContact();
      senderName = contact?.pushname || contact?.name || contact?.number || null;
      senderNumber = contact?.number ?? null;
    } catch {
      senderNumber = (message.author || '').split('@')[0] || null;
    }

    // A reply to the original video message is how a client indicates which
    // video they mean without typing a code.
    let quotedText = null;
    let repliedToUs = false;
    try {
      if (message.hasQuotedMsg) {
        const quoted = await message.getQuotedMessage();
        quotedText = quoted?.body ?? quoted?.caption ?? null;
        // Replying to something we said is someone talking to us, not to the
        // room. `fromMe` is set on the quoted message itself, which is the
        // only reliable way to tell — the sender fields are the client's
        // either way.
        repliedToUs = Boolean(quoted?.fromMe);
      }
    } catch {
      /* best effort */
    }

    /*
     * Tagged by name.
     *
     * `mentionedIds` holds every @mention in the message; ours is this
     * session's own number. A client who types "@NVK when is the reel going
     * out" is addressing us as plainly as anyone can in a group chat, and
     * until this the message was indistinguishable from two of their own
     * people talking.
     */
    let mentionedUs = false;
    try {
      const me = this.client?.info?.wid?._serialized ?? null;
      const ids = message.mentionedIds ?? [];
      mentionedUs = Boolean(
        me && ids.some((id) => (typeof id === 'string' ? id : id?._serialized) === me)
      );
    } catch {
      /* best effort */
    }

    this.emit('message', {
      messageId: message.id?._serialized ?? null,
      groupId: chatId,
      groupName,
      senderName,
      senderNumber,
      body: message.body || '',
      quotedText,
      /*
       * Whether this was aimed at us.
       *
       * A client group holds three-way conversation — the client, their own
       * people, and us — and most of it is not a question for the agency.
       * These two are the signals that it is, and they are the difference
       * between an assistant that answers when spoken to and one that
       * interrupts.
       */
      repliedToUs,
      mentionedUs,
      hasMedia: Boolean(message.hasMedia),
      /*
       * Kept so the router can fetch the audio only when it needs to.
       *
       * Downloading here would pull every image and document a client ever
       * posts through this process, to no purpose. 'ptt' is a recorded voice
       * note; 'audio' is a music file someone attached, and both are worth
       * hearing when they arrive as a reply.
       */
      isVoice: message.type === 'ptt' || message.type === 'audio',
      downloadMedia: () => message.downloadMedia(),
      timestamp: message.timestamp ? new Date(message.timestamp * 1000) : new Date(),
    });
  }

  /* ------------------------------- Outbound ------------------------------ */

  /**
   * Send a video to a group, by URL.
   *
   * Serialised through `sendChain` with a throttle between sends. WhatsApp
   * rate-limits aggressively and treats bursts as spam; a queue of one is the
   * cheapest insurance against getting the number restricted, and approvals
   * are not latency-sensitive enough for parallelism to be worth that risk.
   */
  enqueueSend(job) {
    const run = this.sendChain.then(
      () => this.sendVideo(job),
      () => this.sendVideo(job)
    );
    // Keep the chain alive regardless of this job's outcome, and pace the next.
    this.sendChain = run
      .catch(() => {})
      .then(() => new Promise((r) => setTimeout(r, config.send.throttleMs)));
    return run;
  }

  async sendVideo({ groupId, videoUrl, watchUrl, caption, filename }) {
    if (this.state !== STATE.CONNECTED) {
      const err = new Error(`WhatsApp is not connected (state: ${this.state})`);
      err.code = 'not_connected';
      throw err;
    }
    if (!groupId?.endsWith('@g.us')) {
      const err = new Error(`"${groupId}" is not a WhatsApp group id`);
      err.code = 'bad_group';
      throw err;
    }

    const started = Date.now();
    log.info('fetching media', { groupId, videoUrl: videoUrl.slice(0, 80) });

    // Fetched here rather than handed to WhatsApp as a URL: the library would
    // download it anyway, and doing it ourselves means the size check below
    // happens before Chromium is asked to hold the bytes in memory.
    let media;
    try {
      media = await this.fetchMedia(videoUrl, filename);
    } catch (err) {
      /*
       * Too big for WhatsApp, but not too big to review.
       *
       * The caption still goes, with a link to watch it — the portal sends a
       * public, non-expiring page for exactly this. The client can watch and
       * reply APPROVE from the same group, which is the whole point of the
       * message; only the convenience of inline playback is lost.
       *
       * Any other failure is rethrown: a link is a fallback for a file that
       * cannot be sent, not a cover for one that could not be fetched.
       */
      if (err?.code !== 'media_too_large' || !watchUrl) throw err;

      /*
       * The link takes the video's place, in the video's position.
       *
       * `caption` here is the short label the portal puts on the media — the
       * title, not the post copy, which arrives as its own message straight
       * after. So this message stays the first thing in the group and still
       * says which video it is.
       */
      log.warn('video too large for WhatsApp — sending a link in its place', {
        groupId,
        reason: err.message,
      });

      const text =
        `${caption}\n\n▶️ *Watch the video:*\n${watchUrl}\n\n` +
        `_(Too large to send here, so it opens in your browser.)_`;

      const sentLink = await this.client.sendMessage(groupId, text);
      return {
        messageId: sentLink?.id?._serialized ?? null,
        bytes: 0,
        sentAsLink: true,
        note: err.message,
      };
    }

    log.info('sending', {
      groupId,
      bytes: media.bytes,
      as: media.asDocument ? 'document' : 'video',
      ms: Date.now() - started,
    });

    const sent = await this.client.sendMessage(groupId, media.media, {
      caption,
      // Inline where WhatsApp will play it, as a file where it will not. The
      // client gets the video either way, which is the whole point.
      sendMediaAsDocument: media.asDocument === true,
    });

    return {
      messageId: sent?.id?._serialized ?? null,
      bytes: media.bytes,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Download to a MessageMedia, refusing anything WhatsApp would reject.
   *
   * Two ceilings, not one. WhatsApp plays a video inline up to about 16 MB and
   * accepts a far bigger file as a document — and a client would much rather
   * download a 40 MB reel than be sent a link to it, which is what happened
   * to every video over the inline limit before. So anything past the inline
   * ceiling is still sent, as a document, and only past the document ceiling
   * does the link come back.
   *
   * The document ceiling is deliberately well under WhatsApp's own: the bytes
   * are held in memory and base64 adds a third on top, and the box this runs
   * on has 2 GB for Chromium, the session and this.
   */
  async fetchMedia(url, filename) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`Could not fetch the video (HTTP ${res.status})`);
      err.code = 'media_fetch_failed';
      throw err;
    }

    const ceiling = Math.max(config.send.maxMediaBytes, config.send.maxDocumentBytes);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > ceiling) {
      const err = new Error(
        `Video is ${(declared / 1048576).toFixed(1)} MB; the most we can send here is ` +
          `${(ceiling / 1048576).toFixed(0)} MB`
      );
      err.code = 'media_too_large';
      err.permanent = true; // a bigger file will not get smaller on retry
      throw err;
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    /*
     * A page, not a file.
     *
     * A Google Drive link that has not been shared publicly answers 200 with
     * an HTML sign-in page, and without this that page was sent to the client
     * as a video: a broken attachment, and nobody able to say why. It is a
     * permanent failure — retrying fetches the same page.
     */
    if (type.startsWith('text/html')) {
      const err = new Error(
        'That link returns a web page rather than a file — check it is shared publicly, or upload the video to the portal instead.'
      );
      err.code = 'not_a_file';
      err.permanent = true;
      throw err;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > ceiling) {
      const err = new Error(
        `Video is ${(buffer.byteLength / 1048576).toFixed(1)} MB, over the limit`
      );
      err.code = 'media_too_large';
      err.permanent = true;
      throw err;
    }

    const mimeType = type || 'video/mp4';
    return {
      media: new MessageMedia(mimeType, buffer.toString('base64'), filename || 'video.mp4'),
      bytes: buffer.byteLength,
      // Too big to play in the chat, small enough to send as a file.
      asDocument: buffer.byteLength > config.send.maxMediaBytes,
    };
  }

  /**
   * A PDF into a group, as a file the client can save.
   *
   * `sendMediaAsDocument` is what makes it arrive as a document rather than as
   * an image of the first page — a report somebody can only look at is not the
   * thing that was asked for.
   *
   * The caption travels with the file rather than as a separate message, so
   * the two cannot arrive out of order in a busy group.
   */
  async sendDocument({ groupId, buffer, filename, caption, mimeType = 'application/pdf' }) {
    if (this.state !== STATE.CONNECTED) {
      const err = new Error(`WhatsApp is not connected (state: ${this.state})`);
      err.code = 'not_connected';
      throw err;
    }
    if (!groupId?.endsWith('@g.us')) {
      const err = new Error(`"${groupId}" is not a WhatsApp group id`);
      err.code = 'bad_group';
      throw err;
    }
    if (buffer.byteLength > config.send.maxMediaBytes) {
      const err = new Error(
        `The document is ${(buffer.byteLength / 1048576).toFixed(1)} MB, over WhatsApp's limit`
      );
      err.code = 'media_too_large';
      err.permanent = true;
      throw err;
    }

    const media = new MessageMedia(mimeType, buffer.toString('base64'), filename);
    const sent = await this.client.sendMessage(groupId, media, {
      caption: caption || undefined,
      sendMediaAsDocument: true,
    });
    return { messageId: sent?.id?._serialized ?? null, bytes: buffer.byteLength };
  }

  /** Plain text into a group — used for acknowledgements. */
  async sendText(groupId, text) {
    if (this.state !== STATE.CONNECTED) {
      const err = new Error(`WhatsApp is not connected (state: ${this.state})`);
      err.code = 'not_connected';
      throw err;
    }
    const sent = await this.client.sendMessage(groupId, text);
    return { messageId: sent?.id?._serialized ?? null };
  }

  /**
   * The groups this account is in — for mapping clients in the portal UI.
   *
   * Every route to the chat list goes through code whatsapp-web.js injects
   * into the WhatsApp Web page, and that page ships far more often than the
   * library does. When they disagree the injected code throws from minified
   * source with a one-letter message, or the global it wanted is simply gone.
   * Observed on 1.34.7 against the current web build: window.Store is
   * undefined and WWebJS.getChats() throws 'r'.
   *
   * None of that touches the session, which sends and receives perfectly. So
   * this reports the shortfall rather than failing:
   *
   *   groups  — whatever could be read, possibly empty
   *   warning — non-null ONLY when the list could not be obtained
   *
   * The distinction is the point. An empty list with no warning means "you are
   * in no groups"; an empty list with one means "ask WhatsApp another way".
   * Returning the first when the second is true is what makes a working setup
   * look broken.
   */
  async listGroups() {
    if (this.state !== STATE.CONNECTED) return { groups: [], warning: 'Not connected.' };

    const shape = (raw) =>
      raw
        .map((c) => ({
          groupId: c.groupId || null,
          name: c.name || null,
          participants: c.participants ?? null,
          unread: c.unread ?? 0,
        }))
        .filter((g) => g.groupId);

    // 1. The library's own method. Correct when versions agree.
    try {
      const chats = await this.client.getChats();
      return {
        groups: shape(
          chats
            .filter((c) => c.isGroup)
            .map((c) => ({
              groupId: c.id?._serialized ?? null,
              name: c.name ?? null,
              participants: c.participants?.length ?? null,
              unread: c.unreadCount ?? 0,
            }))
        ),
        warning: null,
      };
    } catch (err) {
      log.warn('getChats failed, trying the page directly', {
        error: err?.message || String(err),
      });
    }

    /*
     * 2. The page, without the library's model layer.
     *
     * Returns null — not [] — when neither global is usable, so "could not
     * read" survives the trip back instead of arriving as "nothing found".
     */
    try {
      const raw = await this.client.pupPage.evaluate(async () => {
        const out = [];
        if (window.WWebJS && typeof window.WWebJS.getChats === 'function') {
          try {
            const chats = await window.WWebJS.getChats();
            for (const c of chats) {
              if (!c.isGroup) continue;
              out.push({
                groupId: (c.id && (c.id._serialized || c.id)) || null,
                name: c.name || c.formattedTitle || null,
                participants: (c.groupMetadata && c.groupMetadata.participants
                  ? c.groupMetadata.participants.length
                  : null),
                unread: c.unreadCount || 0,
              });
            }
            return out;
          } catch {
            // Falls through to the store attempt below.
          }
        }
        const store = window.Store;
        if (!store || !store.Chat || !store.Chat.getModelsArray) return null;
        for (const c of store.Chat.getModelsArray()) {
          if (!c.id || c.id.server !== 'g.us') continue;
          out.push({
            groupId: c.id._serialized || null,
            name: c.name || c.formattedTitle || null,
            participants: (c.groupMetadata && c.groupMetadata.participants
              ? c.groupMetadata.participants.length
              : null),
            unread: c.unreadCount || 0,
          });
        }
        return out;
      });

      if (Array.isArray(raw)) {
        log.info('listed groups from the page', { count: raw.length });
        return { groups: shape(raw), warning: null };
      }
      log.warn('no usable way to read the chat list in this WhatsApp Web build');
    } catch (err) {
      log.warn('reading the chat list from the page failed', {
        error: err?.message || String(err),
      });
    }

    // 3. Nothing worked. Say so, and say what does work instead.
    return {
      groups: [],
      warning:
        "This version of WhatsApp Web won't list groups to the automation — " +
        'a known mismatch with whatsapp-web.js that does not affect sending or ' +
        'receiving. Send any message in the group and it will appear below ' +
        'under groups we have heard from, ready to link.',
    };
  }
}

module.exports = { WhatsAppService, STATE };
