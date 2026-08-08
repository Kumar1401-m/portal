'use strict';

/**
 * Reading approval commands out of a WhatsApp message.
 *
 * The people typing these are clients on phones, not operators following a
 * syntax. So the parser is deliberately forgiving about everything that
 * doesn't change the meaning:
 *
 *   APPROVE V245        approve v245        Approve  v-245
 *   approve #V245       APPROVED V245       ok approve v245
 *   CHANGE V245 make the subtitles bigger
 *   change v245
 *   please make subtitles bigger      ← reply to the video, no code needed
 *
 * and strict about the one thing that does: an approval must name a video, or
 * be an unambiguous reply to one. Guessing which video a bare "ok" refers to
 * is how the wrong video goes live.
 */

/**
 * Video codes look like V245 — a letter prefix and digits. Tolerated:
 * a leading #, a hyphen, any case, and surrounding punctuation.
 */
const CODE = String.raw`#?\s*([A-Za-z]{1,3})[-\s]?(\d{1,8})`;

const APPROVE_RE = new RegExp(
  String.raw`^\s*(?:ok(?:ay)?[\s,.]*)?(?:pls\s+|please\s+)?appro?ved?\b\s*(?:${CODE})?`,
  'i'
);

const CHANGE_RE = new RegExp(
  String.raw`^\s*(?:pls\s+|please\s+)?(?:change|changes|revise|revision|edit|modify|redo)\b\s*(?:${CODE})?`,
  'i'
);

/**
 * Plain agreement, and nothing else.
 *
 * Deliberately anchored to the whole message. "ok" on its own is an approval;
 * "ok but change the music" is not, and must not be read as one — the check
 * below runs after the change test for exactly that reason.
 *
 * Kept narrow: a thumbs-up or a tick is unambiguous, whereas "good" or "nice"
 * is praise for the work and not permission to publish it.
 */
const PLAIN_OK_RE =
  /^\s*(?:ok(?:ay)?|k|yes|yep|yup|sure|done|fine|approved?|👍|👌|✅|🆗|\u{1F44D}\u{1F3FB}?)[\s.!]*$/iu;

const REJECT_RE = new RegExp(
  String.raw`^\s*(?:reject(?:ed)?|cancel(?:led)?|discard|drop)\b\s*(?:${CODE})?`,
  'i'
);

/**
 * "status" on its own, and the handful of ways people ask the same thing.
 *
 * Anchored to the whole message so "what's the status of the music change"
 * stays a conversation rather than triggering a canned report over the top
 * of a real question.
 */
const STATUS_RE = /^\s*(?:status|update|progress)[\s?.!]*$/i;

/**
 * A link to a file-sharing service — which in a client group means footage.
 *
 * Matched anywhere in the message, because people write "here you go <link>".
 *
 * Restricted to hosts people actually send files with, rather than any URL.
 * A client group carries links all day — a competitor's reel, an article, a
 * location on Maps — and any of those silently becoming the raw footage on a
 * task is a worse failure than missing an unusual host, because nobody finds
 * out until an editor opens it. Anyone can send it: the group identifies the
 * client, and footage legitimately arrives from a videographer or a manager
 * as often as from the person who signed the contract.
 *
 * An unlisted host is not lost — it stays in the transcript, and the team can
 * paste it into the task themselves.
 */
const FILE_HOSTS = [
  'drive\\.google\\.com',
  'docs\\.google\\.com',
  'photos\\.app\\.goo\\.gl',
  'dropbox\\.com',
  'we\\.tl',
  'wetransfer\\.com',
  'icloud\\.com',
  'onedrive\\.live\\.com',
  '1drv\\.ms',
  'mega\\.nz',
  'frame\\.io',
  'box\\.com',
  'terabox\\.com',
  'send-anywhere\\.com',
  'pcloud\\.link',
].join('|');

const LINK_RE = new RegExp(
  String.raw`\bhttps?:\/\/[^\s<>"']*(?:${FILE_HOSTS})[^\s<>"']*`,
  'i'
);

const normalizeCode = (prefix, digits) =>
  prefix && digits ? `${prefix.toUpperCase()}${digits}` : null;

/**
 * Pull a video code out of free text, wherever it appears.
 *
 * Used for the "CHANGE" case where a client writes the notes first, and to
 * recover a code from a quoted message when they reply to the original video.
 */
function findCode(text) {
  if (!text) return null;
  const m = new RegExp(CODE).exec(text);
  return m ? normalizeCode(m[1], m[2]) : null;
}

/**
 * @typedef {Object} ParsedCommand
 * @property {'approve'|'change'|'reject'|'none'} command
 * @property {string|null} videoCode
 * @property {string|null} comment   Free text after the command, for CHANGE.
 * @property {boolean} needsContext  True when a command was clear but no code
 *                                   was given — the caller must resolve which
 *                                   video from the quoted message.
 */

/**
 * Parse one message body.
 *
 * Returns `command: 'none'` for ordinary chatter, which is most of what a
 * client group contains. That is not an error and must not be logged as one.
 */
function parseCommand(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return { command: 'none', videoCode: null, comment: null, needsContext: false };

  // Order matters: "change" is checked before "approve" so that a message
  // reading "approved, but change the music" is treated as a change request.
  // Reading that as an approval would publish work the client just objected to
  // — the expensive mistake, so ambiguity resolves towards the safe side.
  const change = CHANGE_RE.exec(text);
  const approve = APPROVE_RE.exec(text);
  const reject = REJECT_RE.exec(text);

  const mentionsChange = Boolean(change) || /\bchange\b/i.test(text);

  if (reject && !mentionsChange) {
    const code = normalizeCode(reject[1], reject[2]) || findCode(text);
    return {
      command: 'reject',
      videoCode: code,
      comment: text.slice(reject[0].length).trim() || null,
      needsContext: !code,
    };
  }

  // A bare "ok" with no code — the common case now that the message shows
  // none. Which video it refers to is the portal's to decide, from the group.
  if (!change && !reject && PLAIN_OK_RE.test(text)) {
    return { command: 'approve', videoCode: null, comment: null, needsContext: true };
  }

  if (mentionsChange) {
    const code = (change && normalizeCode(change[1], change[2])) || findCode(text);

    /*
     * Two shapes, and they need different treatment:
     *
     *   "CHANGE V245 increase subtitle size"
     *      A command with arguments — the instruction is what follows.
     *
     *   "APPROVE V245, actually change the ending"
     *      A sentence that happens to contain the keyword. Slicing after
     *      "change" here yields "the ending", which reads to the editor as a
     *      different (and much vaguer) instruction than the client gave.
     *
     * So the slice only applies when the message genuinely starts with the
     * command; otherwise the whole message is the instruction.
     */
    let comment;
    if (change) {
      comment = text.slice(text.indexOf(change[0]) + change[0].length);
    } else {
      comment = text;
    }

    // The code is addressing, not instruction — strip it either way. Any
    // leading approve/change verb left over goes too, so the editor reads
    // notes rather than protocol.
    if (code) comment = comment.replace(new RegExp(`#?\\s*${code}\\b`, 'ig'), ' ');
    comment = comment
      .replace(/\b(?:pls|please)\b/gi, ' ')
      .replace(/^\s*appro?ved?\b/i, ' ')
      .replace(/[\s,.:;-]+$/g, '')
      .replace(/^[\s,.:;-]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return {
      command: 'change',
      videoCode: code,
      comment: comment || null,
      needsContext: !code,
    };
  }

  if (approve) {
    const code = normalizeCode(approve[1], approve[2]) || findCode(text);
    return {
      command: 'approve',
      videoCode: code,
      comment: null,
      needsContext: !code,
    };
  }

  // Checked after the approval commands: a message that both approves and
  // carries a link is an approval first, and answering it with "got your
  // footage" would be a non-sequitur.
  if (STATUS_RE.test(text)) {
    return { command: 'status', videoCode: null, comment: null, needsContext: false };
  }

  const link = LINK_RE.exec(text);
  if (link) {
    return { command: 'footage', videoCode: null, comment: null, link: link[0], needsContext: false };
  }

  return { command: 'none', videoCode: null, comment: null, needsContext: false };
}

module.exports = { parseCommand, findCode };
