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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
