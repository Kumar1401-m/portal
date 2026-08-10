'use strict';

/**
 * Parser tests. Run with: node src/lib/command-parser.test.js
 *
 * These are written from how clients actually type, not from the documented
 * syntax — lowercase, missing codes, notes before the command, "approved but
 * change the music". The parser is the only place a misread turns into the
 * wrong video going live, so the ambiguous cases are the point of the file.
 */
const assert = require('assert');
const { parseCommand, findCode } = require('./command-parser');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

const cmd = (text) => {
  const p = parseCommand(text);
  return { command: p.command, videoCode: p.videoCode, comment: p.comment };
};

console.log('\nApprovals');
check('canonical', cmd('APPROVE V245'), { command: 'approve', videoCode: 'V245', comment: null });
check('lowercase', cmd('approve v245'), { command: 'approve', videoCode: 'V245', comment: null });
check('mixed case', cmd('Approve V245'), { command: 'approve', videoCode: 'V245', comment: null });
check('hash prefix', cmd('APPROVE #V245'), { command: 'approve', videoCode: 'V245', comment: null });
check('hyphenated', cmd('approve V-245'), { command: 'approve', videoCode: 'V245', comment: null });
check('spaced code', cmd('approve V 245'), { command: 'approve', videoCode: 'V245', comment: null });
check('past tense', cmd('Approved V245'), { command: 'approve', videoCode: 'V245', comment: null });
check('polite', cmd('please approve V245'), { command: 'approve', videoCode: 'V245', comment: null });
check('ok prefix', cmd('ok approve v245'), { command: 'approve', videoCode: 'V245', comment: null });
check('extra spaces', cmd('   APPROVE    V245   '), { command: 'approve', videoCode: 'V245', comment: null });

console.log('Change requests');
check(
  'with notes',
  cmd('CHANGE V245 Increase subtitle size'),
  { command: 'change', videoCode: 'V245', comment: 'Increase subtitle size' }
);
check(
  'lowercase with notes',
  cmd('change v245 make the music quieter'),
  { command: 'change', videoCode: 'V245', comment: 'make the music quieter' }
);
check('no notes', cmd('CHANGE V245'), { command: 'change', videoCode: 'V245', comment: null });
check(
  'newline before notes',
  cmd('CHANGE V245\nIncrease subtitle size'),
  { command: 'change', videoCode: 'V245', comment: 'Increase subtitle size' }
);
check(
  'synonym: revise',
  cmd('revise V245 shorten the intro'),
  { command: 'change', videoCode: 'V245', comment: 'shorten the intro' }
);
check(
  'punctuation after code',
  cmd('CHANGE V245 - fix the logo'),
  { command: 'change', videoCode: 'V245', comment: 'fix the logo' }
);

console.log('Ambiguity — the cases that matter');
// "approved but change X" must never be read as an approval. Reading it that
// way publishes work the client just objected to.
// The comment keeps the whole sentence rather than only what follows the
// keyword. An editor reading "the music" would not know what to do with it;
// "but change the music" is the instruction the client actually gave.
check(
  'approved BUT change → change',
  cmd('approved but change the music please V245'),
  { command: 'change', videoCode: 'V245', comment: 'but change the music' }
);
check(
  'approve then change on two lines → change',
  cmd('APPROVE V245\nactually change the ending'),
  { command: 'change', videoCode: 'V245', comment: 'actually change the ending' }
);

console.log('Rejections');
check('reject', cmd('REJECT V245'), { command: 'reject', videoCode: 'V245', comment: null });
check(
  'reject with reason',
  cmd('reject v245 wrong client'),
  { command: 'reject', videoCode: 'V245', comment: 'wrong client' }
);

console.log('Ordinary chatter must not trigger anything');
for (const noise of [
  'Hi team, good morning',
  'Thanks!',
  'When will the next one be ready?',
  '👍',
  'The client approved the budget yesterday',
  'we need to change our meeting time',
  '',
  '   ',
]) {
  const p = parseCommand(noise);
  // "approved the budget" and "change our meeting" DO contain the keywords, so
  // they parse as commands — but with no code, which routes to "ask which
  // video?" rather than to an approval. That is the safe failure.
  if (p.command !== 'none' && p.videoCode) {
    failed++;
    console.log(`  FAIL  noise triggered a coded command: "${noise}" → ${JSON.stringify(p)}`);
  } else {
    passed++;
  }
}

console.log('Commands without a code flag needsContext');
{
  const p = parseCommand('APPROVE');
  check('bare approve', { c: p.command, code: p.videoCode, ctx: p.needsContext }, {
    c: 'approve',
    code: null,
    ctx: true,
  });
}

console.log('Code extraction from a quoted caption');
check(
  'from the video caption',
  findCode('📹 Video Ready\n\nVideo ID: V245\n\nPlease review.'),
  'V245'
);
check('multi-letter prefix', findCode('APPROVE VID99'), 'VID99');
check('no code present', findCode('hello there'), null);

/*
 * Every example printed on the WhatsApp settings page.
 *
 * The portal cannot import this parser — it is a separate service — so
 * `agency-next/src/app/(app)/settings/whatsapp/keywords.tsx` documents the
 * keywords by hand, which is a promise to clients that could quietly stop
 * being true. These cases are that page, executed. Change the parser and this
 * fails; change this and the page needs the same edit.
 */
console.log('Documented on the WhatsApp settings page');
{
  const doc = (text, command, extra = {}) =>
    check(`"${text}"`, cmd(text), { command, videoCode: null, comment: null, ...extra });

  // Approving, with no code — the common case.
  for (const word of ['OK', 'okay', 'yes', 'yep', 'sure', 'done', 'fine', '👍', '✅']) {
    doc(word, 'approve');
  }
  // Approving a named video.
  for (const text of ['APPROVE V245', 'approve v245', 'approve #V245', 'approve V-245']) {
    check(`"${text}"`, cmd(text), { command: 'approve', videoCode: 'V245', comment: null });
  }

  // Asking for a change. The note is what the editor reads.
  check(
    '"change make the subtitles bigger"',
    cmd('change make the subtitles bigger'),
    { command: 'change', videoCode: null, comment: 'make the subtitles bigger' }
  );
  for (const verb of ['revise', 'edit', 'modify', 'redo']) {
    check(`"${verb} …"`, cmd(`${verb} the ending`).command, 'change');
  }
  // The one the page calls out: this must not publish anything.
  check(
    '"approved, but change the ending"',
    cmd('approved, but change the ending').command,
    'change'
  );
  // ...and its opposite, which must stay an approval.
  check('"ok" is not a change', cmd('ok').command, 'approve');

  // Rejecting.
  for (const word of ['reject', 'cancel', 'discard', 'drop']) {
    check(`"${word}"`, cmd(word).command, 'reject');
  }

  // Status, only as the whole message.
  for (const word of ['status', 'update', 'progress']) doc(word, 'status');
  check(
    'a real question is not a status request',
    cmd("what's the status of the reel?").command,
    'none'
  );

  // The "set off by accident" box. These are documented as false positives, so
  // the test asserts they really do fire — if the parser is ever tightened,
  // this fails and the box comes off the page.
  check(
    'accidental: "change" anywhere counts',
    cmd('we need to change our meeting time').command,
    'change'
  );
  check(
    'accidental: "change" beats "status"',
    cmd("what's the status of the music change?").command,
    'change'
  );
  // ...and the verbs the page promises do NOT do this, because they only
  // count at the start of a message.
  for (const text of [
    'the client approved the budget yesterday',
    'we should edit the plan next week',
    'they might cancel the shoot',
  ]) {
    check(`not accidental: "${text}"`, cmd(text).command, 'none');
  }

  // Footage: a known host speaks for itself.
  for (const host of [
    'https://drive.google.com/file/d/abc/view',
    'https://we.tl/t-abc123',
    'https://www.dropbox.com/s/abc/clip.mp4',
  ]) {
    check(`known host "${host.slice(8, 28)}…"`, parseCommand(host).command, 'footage');
    check(`  link captured`, parseCommand(host).link, host);
  }
  // An unknown host needs a word saying what it is.
  check(
    'unknown host, no word',
    parseCommand('https://filebin.example.com/xyz').command,
    'none'
  );
  for (const word of ['raw', 'footage', 'shoot', 'clips', 'files']) {
    check(
      `unknown host with "${word}"`,
      parseCommand(`${word} https://filebin.example.com/xyz`).command,
      'footage'
    );
  }
  // The page promises this stays a link in a chat.
  check(
    'an article link is not footage',
    parseCommand('have you seen this https://news.example.com/story').command,
    'none'
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
process.exit(failed ? 1 : 0);
