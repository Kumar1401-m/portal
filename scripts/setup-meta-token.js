#!/usr/bin/env node
'use strict';

/**
 * Turn a short-lived Graph Explorer token into the long-lived one the
 * automation needs, and write it where the apps expect it.
 *
 * Run it interactively:
 *
 *   node scripts/setup-meta-token.js
 *
 * What it does, in order:
 *
 *   1. Checks the token is valid and carries every permission needed. This is
 *      the step that matters — a token missing `instagram_manage_insights`
 *      still publishes perfectly, then returns zeros for every analytics call.
 *      Finding that out here beats finding out from an empty dashboard a week
 *      later.
 *   2. Exchanges it for a long-lived user token (~60 days).
 *   3. Derives Page tokens from it. A Page token derived from a LONG-lived
 *      user token does not expire — deriving one from a short-lived token
 *      gives you a token that dies in an hour, which is the usual mistake.
 *   4. Writes agency-next/.env.local and prints the Vercel command.
 *
 * The token is never printed in full and never leaves this machine.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';

/** Everything the publishing and analytics workflows need between them. */
const REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
];

const ROOT = path.resolve(__dirname, '..');
const PORTAL_ENV = path.join(ROOT, 'agency-next', '.env.local');

const c = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Never show more than the ends — enough to tell two tokens apart, no more. */
const mask = (t) => (t && t.length > 20 ? `${t.slice(0, 8)}…${t.slice(-4)} (${t.length} chars)` : '(short)');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });

    // Suppress echo so a pasted secret doesn't sit in the scrollback.
    const onData = (char) => {
      if ([`\n`, `\r`, ``].includes(char.toString())) return;
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (a) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

async function graph(pathname, params = {}) {
  const url = new URL(`${API}/${VERSION}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message} (code ${body.error.code})`);
  return body;
}

async function main() {
  console.log(c.bold('\nMeta token setup\n'));
  console.log('Get a token first:');
  console.log('  1. ' + c.dim('https://developers.facebook.com/tools/explorer'));
  console.log('  2. Pick your app, then "Get User Access Token"');
  console.log('  3. Tick these permissions:\n');
  REQUIRED_SCOPES.forEach((s) => console.log('       ' + s));
  console.log('\n  4. Generate, then copy it.\n');

  const shortToken = await ask('Paste the token (hidden): ', { hidden: true });
  if (!shortToken) { console.log(c.red('No token given.')); process.exit(1); }

  /* ---- 1. Validate, and check the scopes ---- */
  console.log(c.dim('\nChecking the token…'));
  let debug;
  try {
    const r = await graph('/debug_token', { input_token: shortToken, access_token: shortToken });
    debug = r.data || r;
  } catch (err) {
    console.log(c.red(`  Invalid: ${err.message}`));
    process.exit(1);
  }

  if (!debug.is_valid) { console.log(c.red('  Token is not valid.')); process.exit(1); }

  const scopes = debug.scopes || [];
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

  console.log(`  app     : ${debug.application} (${debug.app_id})`);
  console.log(`  expires : ${debug.expires_at ? new Date(debug.expires_at * 1000).toISOString() : 'never'}`);
  console.log('  scopes  :');
  REQUIRED_SCOPES.forEach((s) =>
    console.log(`    ${scopes.includes(s) ? c.green('✓') : c.red('✗')} ${s}`)
  );

  if (missing.length) {
    console.log(c.red(`\n  Missing: ${missing.join(', ')}`));
    console.log('  Go back to Graph Explorer, tick those, regenerate, and run this again.');
    // Refusing here is the whole point: a token missing the insights scope
    // publishes fine and silently returns zeros for analytics.
    process.exit(1);
  }
  console.log(c.green('\n  All required permissions present.'));

  /* ---- 2. Exchange for a long-lived token ---- */
  console.log(c.bold('\nApp secret'));
  console.log(c.dim(`  https://developers.facebook.com/apps/${debug.app_id}/settings/basic/ → App Secret → Show\n`));
  const appSecret = await ask('Paste the app secret (hidden): ', { hidden: true });
  if (!appSecret) { console.log(c.red('No app secret given.')); process.exit(1); }

  console.log(c.dim('\nExchanging for a long-lived token…'));
  let longToken;
  try {
    const r = await graph('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: debug.app_id,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    });
    longToken = r.access_token;
    const days = r.expires_in ? Math.round(r.expires_in / 86400) : 60;
    console.log(c.green(`  Done — valid ~${days} days: ${mask(longToken)}`));
  } catch (err) {
    console.log(c.red(`  Failed: ${err.message}`));
    console.log('  The app secret is usually the culprit — check it was copied whole.');
    process.exit(1);
  }

  /* ---- 3. Derive Page tokens (these do not expire) ---- */
  console.log(c.dim('\nReading your Pages…'));
  const pages = await graph('/me/accounts', {
    access_token: longToken,
    fields: 'id,name,access_token,instagram_business_account{id,username,followers_count}',
  });

  const usable = [];
  for (const p of pages.data || []) {
    const ig = p.instagram_business_account;
    console.log(`  ${p.name}`);
    if (ig) {
      console.log(`    @${ig.username}  ig_user_id=${c.bold(ig.id)}  ${ig.followers_count} followers`);
      if (ig.followers_count < 100) {
        console.log(c.yellow('    note: under 100 followers — Instagram will not serve account insights'));
      }
      usable.push({ page: p.name, pageToken: p.access_token, igId: ig.id, username: ig.username });
    } else {
      console.log(c.dim('    no Instagram Business account linked'));
    }
  }

  if (!usable.length) {
    console.log(c.red('\nNo Instagram Business accounts found on any Page.'));
    process.exit(1);
  }

  // Any Page token from this long-lived user token works for all of them, so
  // the first is as good as any. It does not expire.
  const agencyToken = usable[0].pageToken;

  console.log(c.dim('\nVerifying insights actually work…'));
  let insightsOk = false;
  for (const u of usable) {
    try {
      await graph(`/${u.igId}/insights`, { metric: 'reach', period: 'day', access_token: agencyToken });
      console.log(c.green(`  @${u.username}: insights OK`));
      insightsOk = true;
    } catch (err) {
      console.log(c.yellow(`  @${u.username}: ${err.message}`));
    }
  }
  if (!insightsOk) {
    console.log(c.yellow('\n  No account returned insights. Usually the under-100-followers rule.'));
  }

  /* ---- 4. Write it where the apps look ---- */
  writeEnv(PORTAL_ENV, { META_ACCESS_TOKEN: agencyToken, META_API_VERSION: VERSION });
  console.log(c.green(`\nWrote META_ACCESS_TOKEN to agency-next/.env.local`));

  console.log(c.bold('\nFor production, run:\n'));
  console.log(c.dim('  cd agency-next'));
  console.log(c.dim(`  printf '%s' '<the page token>' | npx vercel env add META_ACCESS_TOKEN production`));
  console.log(c.dim('  npx vercel --prod\n'));
  console.log('  The token is in agency-next/.env.local if you need to copy it.');

  console.log(c.bold('\nInstagram account ids for your clients:\n'));
  usable.forEach((u) => console.log(`  @${u.username.padEnd(22)} ${u.igId}`));
  console.log(c.dim('\n  Set these on each client (Clients → edit → Instagram Business account id).'));
  console.log(c.dim('  Pasting a Facebook Page id there is fine — the portal corrects it.\n'));
}

/** Upsert keys in a .env file, preserving everything else and its comments. */
function writeEnv(file, values) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // A missing file is fine — this creates it.
  }

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text += `${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  }
  fs.writeFileSync(file, text);
}

main().catch((err) => {
  console.error(c.red(`\nFailed: ${err.message}\n`));
  process.exit(1);
});
