/**
 * AI client auto-detection.
 *
 * Given an image (logo / watermark / poster) or extracted brand text, identify
 * which agency client it belongs to:
 *   1. Extract brand cues (logo text, watermark, visible brand name) — via
 *      OpenAI vision when a key is set, otherwise from admin-provided text.
 *   2. Match those cues against client company names + learned fingerprints.
 *   3. Return the best match with a confidence score; if confidence is low,
 *      the caller asks the admin to confirm.
 *   4. Confirmed matches are stored as fingerprints so detection improves.
 */
'use strict';

const { query } = require('../config/db');
const aiService = require('./aiService');

/** Normalise a string for fuzzy comparison. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Similarity 0..1 between two brand strings (substring + token Jaccard). */
function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? inter / union : 0;
}

/**
 * Extract brand cues from an image using OpenAI vision (if configured).
 * Returns { brand_name, logo_text, watermark_text, detected_text } or null.
 */
async function extractFromImage(imageUrl) {
  const system = `You identify brands in marketing images. Return STRICT JSON:
{brand_name, logo_text, watermark_text, detected_text}. Use empty strings if not visible.
brand_name = the business/brand this creative belongs to (from logo or watermark).`;
  const user = 'Identify the brand/logo/watermark in this image. Respond with JSON only.';
  return aiService.callOpenAIVision(system, user, imageUrl);
}

/**
 * Detect the client for a set of cues.
 * @param {object} input { image_url?, brand_text? }
 * @returns {object} { extracted, cues, match, candidates, live }
 */
async function detect(input) {
  const cues = [];
  let extracted = {};
  let live = false;

  if (input.image_url) {
    const vision = await extractFromImage(input.image_url);
    if (vision) {
      live = true;
      extracted = vision;
      ['brand_name', 'logo_text', 'watermark_text', 'detected_text'].forEach((k) => {
        if (vision[k]) cues.push(vision[k]);
      });
    }
  }
  if (input.brand_text) {
    cues.push(input.brand_text);
    extracted.brand_text = input.brand_text;
  }

  // Nothing to match on.
  if (!cues.length) {
    return { extracted, cues, match: null, candidates: [], live, message: 'No brand cues to match. Provide an image (with a vision-enabled key) or brand text.' };
  }

  // Pull clients + their learned fingerprints.
  const clients = await query(
    "SELECT id, company_name FROM clients WHERE status <> 'churned'"
  );
  const fps = await query('SELECT client_id, cue_type, cue_value FROM client_fingerprints');
  const fpByClient = {};
  fps.forEach((f) => { (fpByClient[f.client_id] = fpByClient[f.client_id] || []).push(f.cue_value); });

  const scored = clients.map((c) => {
    const clientCues = [c.company_name, ...(fpByClient[c.id] || [])];
    let best = 0;
    let bestPair = null;
    for (const ic of cues) {
      for (const cc of clientCues) {
        const sc = similarity(ic, cc);
        if (sc > best) { best = sc; bestPair = { imageCue: ic, clientCue: cc }; }
      }
    }
    return { client_id: c.id, company_name: c.company_name, confidence: Number(best.toFixed(2)), matched_on: bestPair };
  }).sort((a, b) => b.confidence - a.confidence);

  const top = scored[0];
  const CONFIDENT = 0.55;
  const match = top && top.confidence >= CONFIDENT ? top : null;

  return {
    extracted,
    cues,
    match,
    candidates: scored.slice(0, 5),
    live,
    message: match
      ? `Matched "${match.company_name}" (${Math.round(match.confidence * 100)}% confidence).`
      : 'No confident match — please confirm the client so I can learn it.',
  };
}

/** Learn a confirmed cue → client mapping (stored as a fingerprint). */
async function learn(clientId, cueValue, cueType, userId) {
  if (!cueValue || !String(cueValue).trim()) return;
  // Avoid duplicate fingerprints.
  const exists = await query(
    'SELECT id FROM client_fingerprints WHERE client_id = ? AND cue_value = ? LIMIT 1',
    [clientId, cueValue]
  );
  if (exists.length) return;
  await query(
    'INSERT INTO client_fingerprints (client_id, cue_type, cue_value, created_by) VALUES (?,?,?,?)',
    [clientId, ['logo', 'watermark', 'brand_text'].includes(cueType) ? cueType : 'brand_text', String(cueValue).slice(0, 500), userId || null]
  );
}

module.exports = { detect, learn, similarity };
