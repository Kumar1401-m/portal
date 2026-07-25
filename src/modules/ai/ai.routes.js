/**
 * AI module — content analysis, caption generation, and quality checks for a
 * deliverable. Results are stored in ai_analysis and surfaced in the UI.
 */
'use strict';

const express = require('express');
const { body, param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const aiService = require('../../services/aiService');
const clientDetect = require('../../services/clientDetectService');
const env = require('../../config/env');

const router = express.Router();
router.use(authenticate, requireAdmin);

async function loadDeliverable(id) {
  const d = await queryOne(
    `SELECT d.*, c.company_name, c.business_type, c.contact_person, c.phone, c.email,
            c.website, c.company_logo_url, c.instagram_link, c.facebook_link, c.youtube_link,
            c.caption_settings, c.placeholder_values, c.caption_template
     FROM deliverables d
     JOIN clients c ON c.id = d.client_id WHERE d.id = ?`,
    [id]
  );
  if (!d) throw ApiError.notFound('Deliverable not found');
  return d;
}

// mysql2 returns JSON columns as objects (or a string if the driver didn't
// parse); normalise defensively.
const asObj = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
};

const ctxOf = (d) => ({
  title: d.title,
  platform: d.platform,
  company: d.company_name,
  businessType: d.business_type,
  notes: d.description,
  rawLink: d.raw_drive_link,
  editedLink: d.edited_link,
  captionSettings: asObj(d.caption_settings),
  placeholders: asObj(d.placeholder_values),
  template: d.caption_template || null,
});

/** Build the rich brief context for the v3 caption generator. */
const v3CtxOf = (d, body = {}) => {
  const cs = asObj(d.caption_settings);
  const ph = asObj(d.placeholder_values);
  return {
    // Never feed a previously-generated caption back in as the brief.
    videoScript: d.content_hook || d.description || d.title || '',
    videoSummary: d.description || d.content_hook || d.title || '',
    businessName: d.company_name,
    businessType: d.business_type,
    ownerName: d.contact_person || '',
    city: ph.location || '',
    country: 'India',
    language: body.language || d.language || cs.language || 'English',
    tone: body.tone || cs.tone || 'Friendly',
    targetAudience: d.target_audience || cs.target_audience || '',
    goal: body.goal || d.promotion_type || 'Engagement',
    logoUrl: d.company_logo_url,
    website: d.website || ph.website || '',
    phone: d.phone || ph.phone || '',
    whatsapp: ph.whatsapp || '',
    email: d.email || '',
    instagram: d.instagram_link || '',
    facebook: d.facebook_link || '',
    youtube: d.youtube_link || '',
    captionLength: body.length || 'Medium',
    specialNotes: d.custom_instructions || d.ai_prompt || '',
    captionSettings: cs,
    placeholders: ph,
    company: d.company_name,
  };
};

/* GET /api/ai/status — which providers are live */
router.get('/status', (req, res) => {
  const live = env.openai.enabled || env.gemini.enabled;
  const engine = env.openai.enabled ? `OpenAI (${env.openai.model})`
    : env.gemini.enabled ? `Gemini (${env.gemini.model})` : null;
  ok(res, {
    openai: env.openai.enabled,
    gemini: env.gemini.enabled,
    mode: live ? `live · ${engine}` : 'demo (template fallback — set GEMINI_API_KEY or OPENAI_API_KEY for real AI)',
  });
});

/* GET /api/ai/caption-defaults — defaults for the caption-settings editor */
router.get('/caption-defaults', (req, res) => {
  ok(res, {
    default_template: aiService.DEFAULT_CAPTION_TEMPLATE,
    default_settings: aiService.DEFAULT_CAPTION_SETTINGS,
    placeholders: Object.entries(aiService.PLACEHOLDER_MAP).map(([token, key]) => ({ token, key })),
  });
});

/* POST /api/ai/detect-client — identify a client from a logo/watermark/brand text */
router.post(
  '/detect-client',
  validate([
    body('image_url').optional({ values: 'falsy' }).isURL().withMessage('image_url must be a URL'),
    body('brand_text').optional({ values: 'falsy' }).isLength({ max: 200 }),
  ]),
  asyncHandler(async (req, res) => {
    if (!req.body.image_url && !req.body.brand_text) {
      throw ApiError.badRequest('Provide an image URL or brand text to detect');
    }
    const result = await clientDetect.detect({
      image_url: req.body.image_url || null,
      brand_text: req.body.brand_text || null,
    });
    audit(req, 'ai_detect_client', 'client', result.match ? result.match.client_id : null,
      result.message, { cues: result.cues });
    ok(res, result, result.message);
  })
);

/* POST /api/ai/confirm-client — learn a confirmed cue → client mapping */
router.post(
  '/confirm-client',
  validate([
    body('client_id').isInt(),
    body('cue_value').isLength({ min: 1, max: 500 }),
    body('cue_type').optional().isIn(['logo', 'watermark', 'brand_text']),
  ]),
  asyncHandler(async (req, res) => {
    const client = await queryOne('SELECT id, company_name FROM clients WHERE id = ?', [Number(req.body.client_id)]);
    if (!client) throw ApiError.notFound('Client not found');
    await clientDetect.learn(client.id, req.body.cue_value, req.body.cue_type || 'brand_text', req.user.id);
    audit(req, 'ai_learn_client', 'client', client.id, `Learned brand cue "${req.body.cue_value}" → ${client.company_name}`);
    ok(res, null, `Learned — future content with "${req.body.cue_value}" will match ${client.company_name}`);
  })
);

/* POST /api/ai/analyze/:deliverableId — full analysis + caption + QC */
router.post(
  '/analyze/:deliverableId',
  validate([param('deliverableId').isInt()]),
  asyncHandler(async (req, res) => {
    const d = await loadDeliverable(Number(req.params.deliverableId));
    const ctx = ctxOf(d);

    const [{ result: analysis, provider }, { result: quality }] = await Promise.all([
      aiService.analyzeContent(ctx),
      aiService.qualityCheck(ctx),
    ]);

    await query('DELETE FROM ai_analysis WHERE deliverable_id = ?', [d.id]);
    await query(
      `INSERT INTO ai_analysis
       (deliverable_id, summary, topic, transcript, caption, cta, hooks, seo_keywords, hashtags,
        thumbnail_title, best_time, suggested_platform, reel_description, alt_text, social_copy,
        quality_json, quality_score, raw_json, provider)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.id,
        analysis.summary || null,
        analysis.topic || null,
        analysis.transcript || null,
        analysis.caption || null,
        analysis.cta || null,
        JSON.stringify(analysis.hooks || []),
        JSON.stringify(analysis.seo_keywords || []),
        analysis.hashtags || null,
        analysis.thumbnail_title || null,
        analysis.best_posting_time || analysis.best_time || null,
        analysis.suggested_platform || null,
        analysis.reel_description || null,
        analysis.alt_text || null,
        analysis.social_copy || null,
        JSON.stringify(quality.checks || {}),
        quality.overall_score || null,
        JSON.stringify({ analysis, quality }),
        provider,
      ]
    );
    await query('UPDATE deliverables SET ai_score = ? WHERE id = ?', [quality.overall_score || null, d.id]);

    audit(req, 'ai_analyze', 'deliverable', d.id, `AI analysis (${provider}) — score ${quality.overall_score}`);
    ok(res, { analysis, quality, provider }, 'AI analysis complete');
  })
);

/* POST /api/ai/caption/:deliverableId — AI Caption Generator v3.
 * Returns the best caption + 5 styled alternates, hashtags, SEO keywords, CTA
 * and per-caption scores. The deliverable's caption is set to the recommended
 * caption (+ hashtags) so it's ready to post. */
router.post(
  '/caption/:deliverableId',
  validate([
    param('deliverableId').isInt(),
    body('tone').optional().isLength({ max: 60 }),
    body('language').optional().isLength({ max: 40 }),
    body('goal').optional().isLength({ max: 40 }),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadDeliverable(Number(req.params.deliverableId));
    const { result: r, brief, provider } = await aiService.generateCaptionV3(v3CtxOf(d, req.body));

    const includeContact = req.body.include_contact !== false;
    const DIV = '-----------------------------------';

    // Social links shown as @handle, not the full URL.
    const handleOf = (link) => {
      if (!link) return '';
      const m = String(link).match(/(?:instagram|facebook)\.com\/([^/?#]+)/i);
      const h = (m ? m[1] : String(link)).replace(/^@+/, '').trim();
      return h ? `@${h}` : '';
    };

    // Contact details — only available fields, each with its icon, no heading.
    const contactLines = [];
    if (includeContact) {
      if (brief.city) contactLines.push(`📍 ${brief.city}`);
      if (brief.phone) contactLines.push(`📞 ${brief.phone}`);
      if (brief.whatsapp) contactLines.push(`💬 ${brief.whatsapp}`);
      if (brief.website) contactLines.push(`🌐 ${brief.website}`);
      if (brief.email) contactLines.push(`📧 ${brief.email}`);
      const ig = handleOf(brief.instagram);
      if (ig) contactLines.push(`📷 ${ig}`);
      const fb = handleOf(brief.facebook);
      if (fb) contactLines.push(`👍 ${fb}`);
      if (brief.youtube) contactLines.push(`▶️ ${brief.youtube}`);
    }
    const contactBlock = contactLines.join('\n');

    // SEO keywords in parentheses, no heading: (Business Name, Category, kw1..kw5).
    const kwItems = [brief.business_name, brief.business_category, ...(r.seo_keywords || [])].filter(Boolean);
    const keywordBlock = `(${kwItems.join(', ')})`;

    // Hashtags — business-name tag leads, no commas, no heading.
    let tags = (r.hashtags || []).map((h) => (String(h).startsWith('#') ? h : `#${h}`));
    const bizTag = brief.business_name ? `#${brief.business_name.replace(/[^A-Za-z0-9]+/g, '')}` : '';
    if (bizTag && !tags.some((t) => t.toLowerCase() === bizTag.toLowerCase())) tags = [bizTag, ...tags];
    const hashtagsStr = tags.join(' ');

    // Posters get a CLEAN, engagement-only caption: no SEO-keyword block, no
    // style "suggestions" — just the engagement body + contact + hashtags.
    // Videos keep the full structured layout (keyword block + swappable styles).
    const isPoster = String(d.video_type || '').toLowerCase() === 'poster';
    let sectionsBelow;
    let composed;
    let altsOut;
    if (isPoster) {
      // v3 alternate order: Professional, Emotional, Engagement, Short, Sales.
      const engBody = (r.alternate_captions || [])[2] || r.recommended_caption || r.best_caption || '';
      sectionsBelow = [contactBlock, hashtagsStr].filter(Boolean).join('\n\n');
      composed = [engBody, sectionsBelow].filter(Boolean).join('\n\n');
      altsOut = []; // suppress the "Try another style" suggestions for posters
    } else {
      sectionsBelow = [contactBlock, keywordBlock, hashtagsStr].filter(Boolean).join(`\n\n${DIV}\n\n`);
      const compose = (bodyText) => [bodyText, sectionsBelow].filter(Boolean).join(`\n\n${DIV}\n\n`);
      composed = compose(r.recommended_caption || r.best_caption || '');
      altsOut = r.alternate_captions;
    }

    // Persist to the caption library (alternates kept in the hooks JSON column).
    await query(
      `INSERT INTO captions (deliverable_id, client_id, platform, month_key, body, hashtags, cta, hooks, is_ai_generated, created_by)
       VALUES (?,?,?,?,?,?,?,?,1,?)`,
      [
        d.id, d.client_id, d.platform, d.month_key || new Date().toISOString().slice(0, 7),
        composed, hashtagsStr || null, r.cta || null,
        JSON.stringify(r.alternate_captions || []), req.user.id,
      ]
    );
    await query(
      "UPDATE deliverables SET caption = ?, status = IF(status IN ('editing','raw_uploaded'),'caption_ready',status) WHERE id = ?",
      [composed, d.id]
    );

    audit(req, 'ai_caption', 'deliverable', d.id, `AI caption generated (${provider})`);
    // `caption` = full ready-to-post output; `sections_below` lets the popup rebuild it per style.
    // Posters return no alternates, so the popup shows a single clean caption (no style buttons).
    ok(res, { provider, caption: composed, sections_below: sectionsBelow, ...r, alternate_captions: altsOut }, 'Caption generated');
  })
);

/* Granular generation targets → ai_analysis columns.
 * The full analysis runs once; only the requested field is persisted, so each
 * "Generate X" button refreshes exactly one output without clobbering others. */
const GENERATE_FIELDS = {
  hooks: (a) => ['hooks', JSON.stringify(a.hooks || [])],
  hashtags: (a) => ['hashtags', a.hashtags || null],
  seo_keywords: (a) => ['seo_keywords', JSON.stringify(a.seo_keywords || [])],
  thumbnail_title: (a) => ['thumbnail_title', a.thumbnail_title || null],
  cta: (a) => ['cta', a.cta || null],
  instagram_caption: (a) => ['caption', a.caption || null],
  facebook_caption: (a) => ['social_copy', a.social_copy || a.caption || null],
  youtube_description: (a) => ['reel_description', a.reel_description || null],
  alt_text: (a) => ['alt_text', a.alt_text || null],
  summary: (a) => ['summary', a.summary || null],
  transcript: (a) => ['transcript', a.transcript || null],
};

/* POST /api/ai/generate/:deliverableId — regenerate one AI output field */
router.post(
  '/generate/:deliverableId',
  validate([
    param('deliverableId').isInt(),
    body('field').isIn(Object.keys(GENERATE_FIELDS)).withMessage('Unknown generation target'),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadDeliverable(Number(req.params.deliverableId));
    const { result: analysis, provider } = await aiService.analyzeContent(ctxOf(d));
    const [column, value] = GENERATE_FIELDS[req.body.field](analysis);

    const existing = await queryOne('SELECT id FROM ai_analysis WHERE deliverable_id = ?', [d.id]);
    if (existing) {
      await query(`UPDATE ai_analysis SET ${column} = ?, provider = ? WHERE id = ?`, [value, provider, existing.id]);
    } else {
      await query(
        `INSERT INTO ai_analysis (deliverable_id, ${column}, provider) VALUES (?,?,?)`,
        [d.id, value, provider]
      );
    }
    audit(req, 'ai_generate', 'deliverable', d.id, `AI generated ${req.body.field} (${provider})`);
    ok(res, { field: req.body.field, column, value, provider, detected_language: analysis.detected_language || null },
      `${req.body.field.replace(/_/g, ' ')} generated`);
  })
);

/* POST /api/ai/quality/:deliverableId — quality check only */
router.post(
  '/quality/:deliverableId',
  validate([param('deliverableId').isInt()]),
  asyncHandler(async (req, res) => {
    const d = await loadDeliverable(Number(req.params.deliverableId));
    const { result, provider } = await aiService.qualityCheck(ctxOf(d));
    await query('UPDATE deliverables SET ai_score = ? WHERE id = ?', [result.overall_score || null, d.id]);
    const existing = await queryOne('SELECT id FROM ai_analysis WHERE deliverable_id = ?', [d.id]);
    if (existing) {
      await query(
        'UPDATE ai_analysis SET quality_json = ?, quality_score = ?, provider = ? WHERE id = ?',
        [JSON.stringify(result.checks || {}), result.overall_score || null, provider, existing.id]
      );
    } else {
      await query(
        'INSERT INTO ai_analysis (deliverable_id, quality_json, quality_score, provider) VALUES (?,?,?,?)',
        [d.id, JSON.stringify(result.checks || {}), result.overall_score || null, provider]
      );
    }
    audit(req, 'ai_quality', 'deliverable', d.id, `Quality check — ${result.overall_score}/100`);
    ok(res, { ...result, provider }, 'Quality check complete');
  })
);

module.exports = router;
