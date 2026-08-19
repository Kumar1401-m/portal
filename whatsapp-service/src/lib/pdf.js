'use strict';

/**
 * Turning a portal page into a PDF.
 *
 * The portal cannot do this itself: it runs on serverless functions, and a
 * PDF of an HTML page needs a real browser. This service already has one —
 * whatsapp-web.js drives Chromium through Puppeteer, so the binary and the
 * library are both installed and neither is a new dependency.
 *
 * It does NOT reuse the WhatsApp session's browser. That browser is started
 * with `--renderer-process-limit=1` to fit a 2 GB box, so a second page would
 * share its one renderer process — and a page that crashed while rendering
 * would take the WhatsApp session down with it. Losing the approval channel to
 * print an invoice is a bad trade, so this launches its own browser, keeps it
 * alive only for the render, and closes it whatever happens.
 *
 * One at a time, always. Two Chromiums plus the session on a 1 vCPU box with
 * n8n on it is how the kernel starts choosing what to kill.
 */
const puppeteer = require('puppeteer');
const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('pdf');

/** Hard ceiling on one render, so a hung page cannot pin a browser open. */
const RENDER_TIMEOUT_MS = 45_000;

/**
 * Same lean flags the session browser uses, and for the same reason: this has
 * to fit alongside it rather than beside a desktop's worth of memory.
 */
const ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=384',
  '--disable-extensions',
  '--disable-background-networking',
  '--mute-audio',
];

/** Only one render at a time — see the note above about the memory budget. */
let chain = Promise.resolve();

/**
 * Render a URL to a PDF buffer.
 *
 * The URL must carry whatever permission it needs in itself; this browser has
 * no session and no cookies, which is the point — it sees exactly what the
 * client following the link from their group will see.
 */
async function renderPdf(url) {
  const run = chain.then(() => renderOnce(url));
  // The queue must survive a failed render, or one bad page blocks every
  // later one for the lifetime of the process.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function renderOnce(url) {
  const started = Date.now();
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: config.whatsapp.executablePath,
      args: ARGS,
      timeout: RENDER_TIMEOUT_MS,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);

    /*
     * `networkidle0` rather than `load`: the document pulls the agency logo
     * and its fonts, and printing before those arrive produces a page with a
     * gap where the letterhead should be — which is exactly the thing the
     * client would notice.
     */
    const res = await page.goto(url, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });
    if (!res || !res.ok()) {
      const status = res ? res.status() : 'no response';
      throw new Error(`The document did not load (${status})`);
    }

    /*
     * Print, not screen. The page's own `@media print` rules hide the
     * controls and set the page box — rendering the screen view would put a
     * "Save as PDF" button in the middle of the client's invoice.
     */
    await page.emulateMediaType('print');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true, // the brand rule and the chart slices ARE the document
      preferCSSPageSize: true, // the page's own @page wins over the format above
      timeout: RENDER_TIMEOUT_MS,
    });

    const buffer = Buffer.from(pdf);
    log.info('rendered', { bytes: buffer.byteLength, ms: Date.now() - started });
    if (!buffer.byteLength) throw new Error('The renderer produced an empty file.');
    return buffer;
  } finally {
    // Closed on every path. A browser left open here is 200 MB the WhatsApp
    // session needs.
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, RENDER_TIMEOUT_MS };
