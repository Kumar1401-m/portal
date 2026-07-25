/**
 * AI content service.
 *
 * When OPENAI_API_KEY is set, requests go to the OpenAI Chat Completions API
 * (JSON mode) for real generation, including vision for client auto-detection.
 * Without a key the service falls back to a deterministic template engine so
 * every AI feature still works end-to-end in development and demos. The
 * response shape is identical either way.
 *
 * Captions honour each client's caption settings (language, tone, length,
 * emoji style, audience, CTA, SEO keywords, branded hashtags) and a structured
 * template with {{placeholders}} that are substituted from the client's
 * placeholder values.
 */
'use strict';

const env = require('./../config/env');
const logger = require('../utils/logger');

/**
 * Default caption template (used when a client has none). Sections mirror the
 * agency's predefined structure: Hook → Problem → Solution → Benefits → CTA →
 * Hashtags → SEO keywords.
 */
const DEFAULT_CAPTION_TEMPLATE = `[HOOK — one bold scroll-stopping line]

[PROBLEM — the pain point the audience feels]

[SOLUTION — how {{BusinessName}} solves it]

[BENEFITS — 2-3 quick benefits/outcomes]

[CTA — {{Offer}} · {{Phone}} · {{Website}}]

[HASHTAGS — 8-12 relevant tags]

[SEO KEYWORDS — comma separated]`;

/** Placeholder tokens supported in templates and their client-value keys. */
const PLACEHOLDER_MAP = {
  '{{BusinessName}}': 'business_name',
  '{{Service}}': 'service',
  '{{Location}}': 'location',
  '{{Phone}}': 'phone',
  '{{WhatsApp}}': 'whatsapp',
  '{{Website}}': 'website',
  '{{Offer}}': 'offer',
  '{{Keywords}}': 'keywords',
};

/** Default caption settings when a client hasn't configured any. */
const DEFAULT_CAPTION_SETTINGS = {
  language: 'English',
  tone: 'friendly and professional',
  length: 'medium',
  emoji_style: 'minimal',
  target_audience: 'general audience',
  cta: '',
  seo_keywords: '',
  branded_hashtags: '',
};

/** Replace {{Placeholder}} tokens with client values (blank if missing). */
function applyPlaceholders(text, values = {}) {
  if (!text) return text;
  let out = String(text);
  for (const [token, key] of Object.entries(PLACEHOLDER_MAP)) {
    const re = new RegExp(token.replace(/[{}]/g, '\\$&'), 'g');
    out = out.replace(re, values[key] || '');
  }
  // Collapse artefacts left by empty placeholders (e.g. " ·  · ").
  return out.replace(/·\s*·/g, '·').replace(/·\s*$/gm, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Low-level OpenAI JSON call. Returns parsed object or null on any failure. */
async function callOpenAI(systemPrompt, userPrompt) {
  if (!env.openai.enabled) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: env.openai.model,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn('OpenAI API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    logger.warn('OpenAI call failed:', err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull the server-suggested retry delay (seconds) out of a 429 body; clamp 1-5s. */
function retryDelayMs(text) {
  const m = String(text).match(/retry(?:Delay)?["':\s]*([\d.]+)s/i);
  const sec = m ? parseFloat(m[1]) : 2.5;
  return Math.min(Math.max(sec || 2.5, 1), 5) * 1000 + 300;
}

/**
 * Low-level Google Gemini JSON call. Returns parsed object or null on failure.
 * Retries automatically on HTTP 429 (free-tier per-minute rate limit) using the
 * server-suggested delay, so a transient throttle self-heals instead of silently
 * dropping to the heuristic draft.
 */
async function callGemini(systemPrompt, userPrompt) {
  if (!env.gemini.enabled) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent?key=${env.gemini.apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  });
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const errText = await res.text();
        const wait = retryDelayMs(errText);
        logger.warn(`Gemini 429 rate-limited (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        logger.warn('Gemini API error:', res.status, await res.text());
        return null;
      }
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      return text ? JSON.parse(text) : null;
    } catch (err) {
      logger.warn(`Gemini call failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err.message);
      if (attempt >= MAX_ATTEMPTS) return null;
      await sleep(800);
    }
  }
  return null;
}

/**
 * Provider-agnostic JSON generation. Tries OpenAI first (if configured), then
 * Gemini, then returns {data:null}. Callers fall back to heuristics on null.
 * @returns {Promise<{data: object|null, provider: 'openai'|'gemini'|null}>}
 */
async function callJSON(systemPrompt, userPrompt) {
  if (env.openai.enabled) {
    const data = await callOpenAI(systemPrompt, userPrompt);
    if (data) return { data, provider: 'openai' };
  }
  if (env.gemini.enabled) {
    const data = await callGemini(systemPrompt, userPrompt);
    if (data) return { data, provider: 'gemini' };
  }
  return { data: null, provider: null };
}

/**
 * Low-level OpenAI vision call (image understanding). Returns parsed JSON or
 * null. Used by the client auto-detection feature.
 */
async function callOpenAIVision(systemPrompt, userPrompt, imageUrl) {
  if (!env.openai.enabled) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: env.openai.model,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn('OpenAI vision error:', res.status);
      return null;
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    logger.warn('OpenAI vision call failed:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Deterministic fallback generators (no API key required)                   */
/* ------------------------------------------------------------------------ */

const HOOKS = [
  'Stop scrolling — this one’s for you 👇',
  'You’ve been doing this wrong the whole time…',
  'The secret nobody in {industry} talks about:',
  'POV: you just found your new favourite {topic}',
  '3 seconds. That’s all this takes to change your {topic} game.',
];

const EMOJI_BY_STYLE = { none: '', minimal: '✨', moderate: '✨🔥', lots: '🔥✨🚀💯' };

function lengthHint(len) {
  return { short: '1-2 short lines', medium: '3-5 lines', long: '6-9 lines' }[len] || '3-5 lines';
}

function fallbackAnalysis(ctx) {
  const s = { ...DEFAULT_CAPTION_SETTINGS, ...(ctx.captionSettings || {}) };
  const ph = ctx.placeholders || {};
  const topic = ctx.title || 'your content';
  const industry = ctx.businessType || 'your industry';
  const company = ph.business_name || ctx.company || 'our team';
  const platform = ctx.platform || 'instagram_reel';
  const isVideo = /reel|short|video|story/.test(platform);
  const emoji = EMOJI_BY_STYLE[s.emoji_style] ?? '✨';

  const hooks = HOOKS.map((h) => h.replace('{industry}', industry).replace('{topic}', topic));

  // Hashtags: mix niche + broad + client's branded hashtags.
  const branded = (s.branded_hashtags || '').split(/[\s,]+/).filter(Boolean);
  const baseTags = [
    `#${industry.toLowerCase().replace(/\s+/g, '')}`,
    `#${String(company).toLowerCase().replace(/\s+/g, '')}`,
    '#trending', '#viral', '#explore', '#reels', '#localbusiness',
    '#marketing', '#growth', '#instadaily',
  ];
  const hashtags = [...new Set([...branded, ...baseTags])].slice(0, 12).join(' ');

  const cta = s.cta
    ? applyPlaceholders(s.cta, ph)
    : `Follow for more & DM us to know more! ${emoji}`.trim();

  const seoKeywords = (s.seo_keywords
    ? s.seo_keywords.split(/[,\n]/).map((x) => x.trim())
    : [topic, industry, 'social media', 'digital marketing', company]
  ).filter(Boolean);

  // Build a caption that follows the client's template (or the default),
  // then substitute placeholders.
  const template = ctx.template || DEFAULT_CAPTION_TEMPLATE;
  const filledTemplate = applyPlaceholders(template, ph);
  const caption = applyPlaceholders([
    `${hooks[0]}`,
    '',
    `Struggling with ${industry.toLowerCase()}? You're not alone.`,
    `${company} makes ${topic.toLowerCase()} simple — crafted for ${s.target_audience}.`,
    `${emoji} Real results, no fluff.`,
    '',
    cta,
    '',
    hashtags,
  ].join('\n'), ph);

  return {
    transcript: isVideo
      ? '(Transcript placeholder — connect the OpenAI API key to enable real speech extraction.)'
      : null,
    scene: isVideo ? 'Fast-paced product/service showcase with on-screen text.' : 'Static creative.',
    topic,
    detected_language: s.language || 'English',
    summary: `A ${isVideo ? 'short-form video' : 'creative'} for ${company} about "${topic}", targeted at ${s.target_audience} on ${platform.replace(/_/g, ' ')}. Tone: ${s.tone}, length: ${s.length}.`,
    caption,
    template_used: filledTemplate,
    cta,
    hooks,
    seo_keywords: seoKeywords,
    hashtags,
    thumbnail_title: `${topic.toUpperCase()} — MUST WATCH`,
    best_posting_time: 'Weekdays 7:00–9:00 PM IST (peak engagement window)',
    suggested_platform: isVideo ? 'Instagram Reels + YouTube Shorts' : 'Instagram Feed + Facebook',
    reel_description: `${topic} | ${company} — watch till the end! ${hashtags}`,
    alt_text: `${company} ${isVideo ? 'video' : 'poster'} about ${topic}`,
    social_copy: `New on our page: ${topic}! ${cta}`,
  };
}

function fallbackQuality(ctx) {
  const seedStr = `${ctx.title || ''}${ctx.editedLink || ''}`;
  let seed = 0;
  for (const ch of seedStr) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const base = 72 + (seed % 21);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const checks = {
    video_quality: { score: clamp(base + 4), note: 'Sharp footage, good lighting.' },
    resolution: { score: clamp(base + 6), note: 'Estimated 1080p or higher.' },
    aspect_ratio: { score: clamp(base + 2), note: /reel|short|story/.test(ctx.platform || '') ? '9:16 vertical — correct for platform.' : 'Matches platform requirement.' },
    audio_quality: { score: clamp(base - 3), note: 'Clear voice, minor background noise.' },
    subtitles: { score: clamp(base - 6), note: 'Consider adding burned-in captions for silent viewers.' },
    hook_strength: { score: clamp(base - 1), note: 'First 3 seconds hold attention; could add on-screen text.' },
    copyright_music: { score: clamp(base + 5), note: 'No known copyrighted track detected.' },
  };
  const overall = clamp(
    Object.values(checks).reduce((s, c) => s + c.score, 0) / Object.keys(checks).length
  );
  return { checks, overall_score: overall, verdict: overall >= 80 ? 'Ready to publish' : 'Good — minor improvements suggested' };
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

function buildSettingsBlock(ctx) {
  const s = { ...DEFAULT_CAPTION_SETTINGS, ...(ctx.captionSettings || {}) };
  const ph = ctx.placeholders || {};
  const phLines = Object.entries(PLACEHOLDER_MAP)
    .map(([token, key]) => `${token} = ${ph[key] || '(not set)'}`)
    .join('\n');
  return { s, ph, phLines };
}

/**
 * Full content analysis for a deliverable (speech, topic, captions, SEO...),
 * honouring the client's caption settings, template and placeholders.
 */
async function analyzeContent(ctx) {
  const { s, phLines } = buildSettingsBlock(ctx);
  const template = ctx.template || DEFAULT_CAPTION_TEMPLATE;

  const system = `You are a senior social media strategist for a digital marketing agency.
Analyze the described content and return STRICT JSON with keys:
transcript, scene, topic, detected_language, summary, caption, cta, hooks (array of 5),
seo_keywords (array), hashtags (single space-separated string), thumbnail_title,
best_posting_time, suggested_platform, reel_description, alt_text, social_copy.

Write the caption in ${s.language}. Tone: ${s.tone}. Length: ${lengthHint(s.length)}.
Emoji usage: ${s.emoji_style}. Target audience: ${s.target_audience}.
${s.cta ? `Preferred CTA: ${s.cta}.` : ''}
${s.branded_hashtags ? `Always include these branded hashtags: ${s.branded_hashtags}.` : ''}
${s.seo_keywords ? `Weave in these SEO keywords: ${s.seo_keywords}.` : ''}

The "caption" MUST follow this template exactly (fill each section):
${template}

Substitute these placeholder values wherever the tokens appear:
${phLines}
Also set "detected_language" to the language you actually wrote in.`;

  const user = `Content details:
Title: ${ctx.title}
Platform: ${ctx.platform}
Client company: ${ctx.company || 'N/A'}
Business type: ${ctx.businessType || 'N/A'}
Notes/description: ${ctx.notes || 'N/A'}
Video/creative link: ${ctx.editedLink || ctx.rawLink || 'N/A'}
(You cannot open the link; infer from the metadata provided.)`;

  const { data: ai, provider } = await callJSON(system, user);
  if (ai) {
    // Substitute any placeholders the model left literal.
    ai.caption = applyPlaceholders(ai.caption, ctx.placeholders);
    ai.cta = applyPlaceholders(ai.cta, ctx.placeholders);
    return { result: ai, provider };
  }
  return { result: fallbackAnalysis(ctx), provider: 'heuristic' };
}

/** AI quality check — per-dimension checks and an overall /100 score. */
async function qualityCheck(ctx) {
  const system = `You are a video QC specialist. Based on the metadata, estimate quality.
Return STRICT JSON: {checks: {video_quality:{score,note}, resolution:{score,note},
aspect_ratio:{score,note}, audio_quality:{score,note}, subtitles:{score,note},
hook_strength:{score,note}, copyright_music:{score,note}}, overall_score, verdict}.
Scores are integers 0-100.`;
  const user = `Title: ${ctx.title}\nPlatform: ${ctx.platform}\nLink: ${ctx.editedLink || 'N/A'}\nNotes: ${ctx.notes || 'N/A'}`;

  const { data: ai, provider } = await callJSON(system, user);
  if (ai && ai.overall_score !== undefined) return { result: ai, provider };
  return { result: fallbackQuality(ctx), provider: 'heuristic' };
}

/** Generate just a caption (used by the caption composer). */
async function generateCaption(ctx) {
  const { result, provider } = await analyzeContent(ctx);
  return {
    provider,
    caption: result.caption,
    hashtags: result.hashtags,
    cta: result.cta,
    hooks: result.hooks,
    detected_language: result.detected_language,
  };
}

/* ------------------------------------------------------------------------ */
/* AI Social Media Caption Generator v3                                      */
/* Rich brief in → structured JSON out (best caption + 5 styled alternates,  */
/* hashtags, SEO keywords, CTA, per-caption scores, recommendation).         */
/* ------------------------------------------------------------------------ */

const CAPTION_V3_SYSTEM = `You are a Professional Social Media Caption Generator for Instagram, Facebook, YouTube Shorts, Threads and LinkedIn. Write HIGH-QUALITY captions like an experienced Social Media Manager, for ANY business category (doctors, dental, hospitals, restaurants, real estate, loans/finance, gyms, salons, jewellery, education, automobile, startups, personal brands, etc.). Automatically understand the industry from the script.

You receive a JSON brief. Then:
1. READ and fully understand video_script. NEVER copy it — write ORIGINAL marketing copy that MATCHES the video's message (it is shown to the client, so it must fit the video). Grab attention in the first 2 lines. Use storytelling, conversational language and line breaks for readability. No clickbait, no fake promises, no fake statistics or awards.
2. DETECT the business and industry from the script + brief. If business_name is empty, use logo_text.
3. WRITE in the requested language (Telugu, English or Tenglish = Telugu in English letters) and respect caption_length (Short / Medium / Long).
4. EMOJIS: natural, MAX 1-2 per sentence, chosen to FIT the business category (dental 🦷😁✨, doctor/hospital 🩺❤️🏥, finance/loan 💰🏦💳, gym 💪🏋️, restaurant 🍽️😋, cafe ☕, real estate 🏠🔑, interior 🏡🛋️, jewellery 💎✨, beauty 💄✨, education 📚🎓, automobile 🚗, general ⭐✨). Never random emojis.
5. CTA: weave ONE business-appropriate CTA into the caption (e.g. "📞 Book your appointment today", "💬 Message us for details", "📲 Contact us now", "🌐 Visit our website").
6. SEO KEYWORDS (seo_keywords): return EXACTLY 5 keyword phrases from the VIDEO TOPIC, with local search intent where relevant. Do NOT include the business name or category (they are added separately). No '#', no duplicates.
7. HASHTAGS (hashtags): return 10-15, no duplicates, NO commas. Mix: business name, topic, industry, location and trending niche tags. Never unrelated tags.
8. Also produce 5 DIFFERENT alternate caption bodies in this order: (1) Professional (2) Emotional (3) Engagement (4) Short (5) Sales — never repeat wording. Score each (engagement/seo/lead_generation/overall out of 100), recommend the strongest, and rewrite any scoring below 90.

RULES: Unique every time, human-like, matches the video, professional & premium tone. Naturally incorporate business name / owner / location where relevant without forcing them. NEVER invent an owner, business name, location or contact detail that is not in the brief. Do NOT list contact details (phone, website, email, handles) inside the caption body — those are shown in a separate section.

Return ONLY strict JSON with EXACTLY these keys:
{"detected_business":"","detected_owner":"","industry":"","main_topic":"","best_caption":"","alternate_captions":["","","","",""],"hashtags":[],"seo_keywords":[],"cta":"","scores":{"caption1":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption2":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption3":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption4":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption5":{"engagement":0,"seo":0,"lead_generation":0,"overall":0}},"recommended_caption":""}`;

/** Assemble the v3 brief object from a deliverable/client context. */
function v3Brief(ctx) {
  const s = { ...DEFAULT_CAPTION_SETTINGS, ...(ctx.captionSettings || {}) };
  const ph = ctx.placeholders || {};
  const name = ctx.businessName || ph.business_name || ctx.company || '';
  return {
    video_script: ctx.videoScript || ctx.notes || '',
    video_summary: ctx.videoSummary || '',
    business_name: name,
    business_type: ctx.businessType || '',
    owner_name: ctx.ownerName || '',
    city: ctx.city || ph.location || '',
    area: ctx.area || '',
    state: ctx.state || '',
    country: ctx.country || 'India',
    language: ctx.language || s.language || 'English',
    tone: ctx.tone || s.tone || 'Friendly',
    target_audience: ctx.targetAudience || s.target_audience || '',
    goal: ctx.goal || 'Engagement',
    business_category: ctx.businessType || '',
    designation: ctx.designation || '',
    caption_length: ctx.captionLength || 'Medium',
    logo_detected: !!ctx.logoUrl,
    logo_text: name,
    brand_colors: [],
    website: ctx.website || ph.website || '',
    phone: ctx.phone || ph.phone || '',
    whatsapp: ctx.whatsapp || ph.whatsapp || '',
    email: ctx.email || '',
    instagram: ctx.instagram || '',
    facebook: ctx.facebook || '',
    youtube: ctx.youtube || '',
    special_notes: ctx.specialNotes || '',
  };
}

/** Coerce the model's JSON into the exact v3 shape (defensive normalisation). */
function normaliseV3(ai) {
  const toArr = (v) => (Array.isArray(v) ? v : v ? String(v).split(/[\s,]+/).filter(Boolean) : []);
  ai.hashtags = toArr(ai.hashtags).map((h) => (String(h).startsWith('#') ? h : `#${h}`));
  ai.seo_keywords = Array.isArray(ai.seo_keywords) ? ai.seo_keywords : toArr(ai.seo_keywords);
  ai.alternate_captions = Array.isArray(ai.alternate_captions)
    ? ai.alternate_captions.map((x) => String(x || '').trim()).filter(Boolean)
    : [ai.best_caption].filter(Boolean);
  const alts = ai.alternate_captions;

  // Some models return best/recommended as a POINTER ("best_caption", "caption3")
  // instead of the actual text — resolve those to real caption text.
  const deref = (v, fallback) => {
    const s = String(v || '').trim();
    const m = s.match(/^caption\s*([1-5])$/i);
    if (m) return alts[Number(m[1]) - 1] || fallback || '';
    if (/^(best|recommended)[_\s-]?caption$/i.test(s) || s.length < 15) return fallback || '';
    return s;
  };
  ai.best_caption = deref(ai.best_caption, alts[0]) || alts[0] || '';
  ai.recommended_caption = deref(ai.recommended_caption, ai.best_caption) || ai.best_caption || alts[0] || '';
  ai.scores = ai.scores || {};
  return ai;
}

/** Deterministic v3 output when the OpenAI key is not set (English only). */
function fallbackCaptionV3(brief) {
  const biz = brief.business_name || brief.logo_text || 'our brand';
  const industry = brief.business_type || 'business';
  const city = brief.city || '';
  const owner = brief.owner_name || '';
  // Use the script's own opening line as the hook (it's already written in the
  // client's language) — never dump the whole script into the caption.
  const rawContent = (brief.video_summary || brief.video_script || '').trim();
  const firstLine = rawContent.split(/\r?\n/)
    .map((s) => s.replace(/^["“”\s]+|["“”\s]+$/g, '').trim())
    .filter(Boolean)[0] || '';
  const loc = city ? ` in ${city}` : '';
  const hook = (firstLine || `Looking for the best ${industry.toLowerCase()}${loc}?`).slice(0, 130);
  const topic = hook;
  const brand = `${biz}${loc}`;
  const goal = brief.goal || 'Engagement';
  const cta = ['Leads', 'Appointments'].includes(goal)
    ? (brief.phone ? `📞 Call us today: ${brief.phone}` : '📩 DM us to book your appointment')
    : goal === 'Sales' ? '🛒 Order now — limited-time offer!' : '👉 Follow & DM us to know more';

  const styled = {
    professional: `${hook}\n\n${brand}${owner ? ` · ${owner}` : ''}\n${cta}`,
    emotional: `${hook}\n\nAt ${brand}, we make it happen for you. ✨\n${cta}`,
    engagement: `${hook}\n\n💬 Comment & share your thoughts 👇\n${brand}\n${cta}`,
    short: `${hook}\n${brand} · ${cta}`,
    sales: `${hook}\n\n🔥 Limited slots! ${cta}\n${brand}`,
  };
  const alts = [styled.professional, styled.emotional, styled.engagement, styled.short, styled.sales];

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  // 10-15 hashtags: brand, owner, industry, location, trending.
  const hashtags = [...new Set([
    biz && `#${slug(biz)}`,
    owner && `#${slug(owner)}`,
    `#${slug(industry)}`,
    `#${slug(industry)}business`,
    `#${slug(industry)}nearme`,
    city && `#${slug(city)}`,
    city && `#${slug(city)}business`,
    '#trending', '#viral', '#reels', '#explore', '#localbusiness', '#india',
  ].filter(Boolean))].slice(0, 13);

  // 5 topic keywords (business name + category are prepended by the route).
  const seo = [
    city ? `best ${industry} in ${city}` : `best ${industry}`,
    `${industry} near me`,
    `${industry} services`,
    `${industry} tips`,
    `${industry} consultation`,
  ].filter(Boolean).slice(0, 5);

  const sc = (e, s, l) => ({ engagement: e, seo: s, lead_generation: l, overall: Math.round((e + s + l) / 3) });
  return {
    detected_business: biz,
    detected_owner: owner,
    industry,
    main_topic: topic.slice(0, 120),
    best_caption: alts[0],
    alternate_captions: alts,
    hashtags,
    seo_keywords: seo,
    cta,
    scores: {
      caption1: sc(92, 94, 93), caption2: sc(95, 90, 92), caption3: sc(96, 91, 90),
      caption4: sc(90, 92, 91), caption5: sc(93, 91, 95),
    },
    recommended_caption: alts[0],
    heuristic_note: 'Set OPENAI_API_KEY for full v3 captions (including proper Telugu / Tenglish).',
  };
}

/** Public: AI Caption Generator v3. */
async function generateCaptionV3(ctx) {
  const brief = v3Brief(ctx);
  const { data: ai, provider } = await callJSON(CAPTION_V3_SYSTEM, JSON.stringify(brief, null, 2));
  if (ai && (ai.best_caption || ai.recommended_caption || ai.alternate_captions)) {
    return { result: normaliseV3(ai), brief, provider };
  }
  return { result: fallbackCaptionV3(brief), brief, provider: 'heuristic' };
}

/**
 * AI growth insights for a client (Cluster D). Uses recent analytics + content
 * mix; falls back to heuristics without a key.
 * @param {object} ctx {company, stats:{...}, topPlatforms:[], postCount}
 */
async function growthInsights(ctx) {
  const system = `You are a social media growth analyst. Given the metrics, return STRICT JSON:
{best_posting_time, best_content_type, posting_frequency, growth_suggestions:[3 strings],
caption_improvements:[3 strings], hashtag_suggestions:[8 strings]}.`;
  const user = `Client: ${ctx.company}
Followers: ${ctx.stats?.followers}, 30d reach: ${ctx.stats?.reach}, engagement: ${ctx.stats?.engagement_rate}%
Top platforms: ${(ctx.topPlatforms || []).join(', ') || 'n/a'}
Posts in last 30d: ${ctx.postCount || 0}`;

  const { data: ai, provider } = await callJSON(system, user);
  if (ai && ai.best_posting_time) return { result: ai, provider };

  // Heuristic fallback
  const er = Number(ctx.stats?.engagement_rate || 0);
  return {
    result: {
      best_posting_time: 'Weekdays 7–9 PM IST; Sundays 11 AM–1 PM',
      best_content_type: (ctx.topPlatforms || [])[0] || 'Short-form video (Reels/Shorts)',
      posting_frequency: ctx.postCount >= 20 ? 'Great cadence — keep 5-6 posts/week' : 'Increase to 5-6 posts/week for faster growth',
      growth_suggestions: [
        er < 3 ? 'Engagement is low — add stronger hooks in the first 3 seconds.' : 'Engagement is healthy — double down on your best-performing format.',
        'Post consistently at peak hours and use 2-3 trending audios weekly.',
        'Run one collaboration/UGC post per week to reach new audiences.',
      ],
      caption_improvements: [
        'Open with a bold question or bold claim as the hook.',
        'Add one clear CTA per caption (comment, save, or DM).',
        'Keep the first line under 8 words so it survives the "more" cut-off.',
      ],
      hashtag_suggestions: ['#reels', '#trending', '#explore', '#viral', '#smallbusiness', '#contentcreator', '#growth', '#marketing'],
    },
    provider: 'heuristic',
  };
}

module.exports = {
  analyzeContent,
  qualityCheck,
  generateCaption,
  generateCaptionV3,
  growthInsights,
  callOpenAIVision,
  applyPlaceholders,
  DEFAULT_CAPTION_TEMPLATE,
  DEFAULT_CAPTION_SETTINGS,
  PLACEHOLDER_MAP,
};
