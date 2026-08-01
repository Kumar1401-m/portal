/**
 * AI Caption Generator v3 (server-only) — ported from the original portal's
 * aiService + ai.routes caption endpoint.
 *
 * Flow: build a rich brief from the deliverable + client → ask Gemini (or OpenAI)
 * for structured JSON (best caption + 5 styled alternates + hashtags + SEO +
 * scores) → compose the final, ready-to-post caption (body + contact block +
 * keyword block + hashtags). Posters get a clean, engagement-only caption.
 * Falls back to a deterministic draft when no API key / the model is unavailable.
 */
import "server-only";
import { env } from "./env";

/* ------------------------------ Types ------------------------------ */

export type CaptionOptions = {
  tone?: string;
  language?: string;
  goal?: string;
  length?: string;
  include_contact?: boolean;
};

/** A deliverable row joined with its client's caption fields. */
export type CaptionSource = {
  id: number;
  client_id: number;
  title: string;
  description: string | null;
  content_hook: string | null;
  platform: string | null;
  video_type: string | null;
  promotion_type: string | null;
  language: string | null;
  target_audience: string | null;
  custom_instructions: string | null;
  ai_prompt: string | null;
  month_key: string | null;
  // client fields
  company_name: string;
  business_type: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  company_logo_url: string | null;
  instagram_link: string | null;
  facebook_link: string | null;
  youtube_link: string | null;
  caption_settings: unknown;
  placeholder_values: unknown;
};

type V3Result = {
  detected_business: string;
  detected_owner: string;
  industry: string;
  main_topic: string;
  best_caption: string;
  alternate_captions: string[];
  hashtags: string[];
  seo_keywords: string[];
  cta: string;
  scores: Record<string, Record<string, number>>;
  recommended_caption: string;
  heuristic_note?: string;
};

type V3Brief = ReturnType<typeof v3Brief>;

export type ComposedCaption = {
  provider: "openai" | "gemini" | "heuristic";
  caption: string;
  sections_below: string;
  hashtags: string;
  cta: string;
  alternate_captions: string[];
  seo_keywords: string[];
  is_poster: boolean;
};

/* --------------------------- JSON helpers --------------------------- */

const asObj = (v: unknown): Record<string, unknown> => {
  if (!v) return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Server-suggested retry delay (seconds) from a 429 body; clamp 1–5s. */
function retryDelayMs(text: string): number {
  const m = text.match(/retry(?:Delay)?["':\s]*([\d.]+)s/i);
  const sec = m ? parseFloat(m[1]) : 2.5;
  return Math.min(Math.max(sec || 2.5, 1), 5) * 1000 + 300;
}

/* ------------------------- Provider calls -------------------------- */

async function callGemini(
  systemPrompt: string,
  userPrompt: string
): Promise<Record<string, unknown> | null> {
  if (!env.gemini.enabled) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent?key=${env.gemini.apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
  });
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.status === 429 && attempt < MAX) {
        await sleep(retryDelayMs(await res.text()));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const text: string = (data?.candidates?.[0]?.content?.parts || [])
        .map((p: { text?: string }) => p.text || "")
        .join("");
      return text ? JSON.parse(text) : null;
    } catch {
      if (attempt >= MAX) return null;
      await sleep(800);
    }
  }
  return null;
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string
): Promise<Record<string, unknown> | null> {
  if (!env.openai.enabled) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: env.openai.model,
        response_format: { type: "json_object" },
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}

/**
 * Ask whichever provider is configured for a JSON object, OpenAI first.
 * Exported so other AI features (analytics recommendations) share one place
 * that knows about keys, models and fallbacks. Returns a null `data` when no
 * provider is available or every one of them failed — callers are expected to
 * have a non-AI fallback rather than to treat this as fatal.
 */
export async function callJSON(
  systemPrompt: string,
  userPrompt: string
): Promise<{ data: Record<string, unknown> | null; provider: "openai" | "gemini" | null }> {
  if (env.openai.enabled) {
    const data = await callOpenAI(systemPrompt, userPrompt);
    if (data) return { data, provider: "openai" };
  }
  if (env.gemini.enabled) {
    const data = await callGemini(systemPrompt, userPrompt);
    if (data) return { data, provider: "gemini" };
  }
  return { data: null, provider: null };
}

/* ------------------------- Brief building -------------------------- */

/** Rich brief context from a deliverable + client, honouring caption settings. */
function v3Brief(d: CaptionSource, opts: CaptionOptions = {}) {
  const cs = asObj(d.caption_settings);
  const ph = asObj(d.placeholder_values);
  const name = d.company_name || "";

  const videoScript = str(d.content_hook || d.description || d.title);
  const videoSummary = str(d.description || d.content_hook || d.title);

  return {
    video_script: videoScript,
    video_summary: videoSummary,
    business_name: name,
    business_type: str(d.business_type),
    owner_name: str(d.contact_person),
    city: str(ph.location || ph.city || ""),
    area: str(ph.area || ""),
    country: str(ph.country || cs.country || "India"),
    language: str(opts.language || d.language || cs.language || "English"),
    tone: str(opts.tone || cs.tone || "Friendly"),
    target_audience: str(d.target_audience || cs.target_audience || ""),
    goal: str(opts.goal || d.promotion_type || "Engagement"),
    business_category: str(d.business_type),
    caption_length: str(opts.length || "Medium"),
    logo_detected: Boolean(d.company_logo_url),
    logo_text: name,
    website: str(d.website || ph.website || ""),
    phone: str(d.phone || ph.phone || ""),
    whatsapp: str(ph.whatsapp || ""),
    email: str(d.email || ""),
    instagram: str(d.instagram_link || ""),
    facebook: str(d.facebook_link || ""),
    youtube: str(d.youtube_link || ""),
    special_notes: str(d.custom_instructions || d.ai_prompt || ""),
  };
}

const CAPTION_V3_SYSTEM = `You are a Professional Social Media Caption Generator for Instagram, Facebook, YouTube Shorts, Threads and LinkedIn. Write HIGH-QUALITY captions like an experienced Social Media Manager, for ANY business category (doctors, dental, hospitals, restaurants, real estate, loans/finance, gyms, salons, jewellery, education, automobile, startups, personal brands, etc.). Automatically understand the industry from the script.

You receive a JSON brief. Then:
1. READ and fully understand video_script. NEVER copy it — write ORIGINAL marketing copy that MATCHES the video's message (it is shown to the client, so it must fit the video). Grab attention in the first 2 lines. Use storytelling, conversational language and line breaks for readability. No clickbait, no fake promises, no fake statistics or awards.
2. DETECT the business and industry from the script + brief. If business_name is empty, use logo_text.
3. WRITE in the requested language (Telugu, English or Tenglish = Telugu in English letters) and respect caption_length (Short / Medium / Long). Localise spelling, phrasing and references to the brief's country.
4. EMOJIS: natural, MAX 1-2 per sentence, chosen to FIT the business category (dental 🦷😁✨, doctor/hospital 🩺❤️🏥, finance/loan 💰🏦💳, gym 💪🏋️, restaurant 🍽️😋, cafe ☕, real estate 🏠🔑, interior 🏡🛋️, jewellery 💎✨, beauty 💄✨, education 📚🎓, automobile 🚗, general ⭐✨). Never random emojis.
5. CTA: weave ONE business-appropriate CTA into the caption (e.g. "📞 Book your appointment today", "💬 Message us for details", "📲 Contact us now", "🌐 Visit our website").
6. SEO KEYWORDS (seo_keywords): return EXACTLY 5 keyword phrases from the VIDEO TOPIC, with local search intent where relevant. Do NOT include the business name or category (they are added separately). No '#', no duplicates.
7. HASHTAGS (hashtags): return 10-15, no duplicates, NO commas. Mix: business name, topic, industry, location and trending niche tags. Never unrelated tags.
8. Also produce 5 DIFFERENT alternate caption bodies in this order: (1) Professional (2) Emotional (3) Engagement (4) Short (5) Sales — never repeat wording. Score each (engagement/seo/lead_generation/overall out of 100), recommend the strongest, and rewrite any scoring below 90.

RULES: Unique every time, human-like, matches the video, professional & premium tone. Naturally incorporate business name / owner / location where relevant without forcing them. NEVER invent an owner, business name, location or contact detail that is not in the brief. Do NOT list contact details (phone, website, email, handles) inside the caption body — those are shown in a separate section.

Return ONLY strict JSON with EXACTLY these keys:
{"detected_business":"","detected_owner":"","industry":"","main_topic":"","best_caption":"","alternate_captions":["","","","",""],"hashtags":[],"seo_keywords":[],"cta":"","scores":{"caption1":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption2":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption3":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption4":{"engagement":0,"seo":0,"lead_generation":0,"overall":0},"caption5":{"engagement":0,"seo":0,"lead_generation":0,"overall":0}},"recommended_caption":""}`;

/** Coerce the model's JSON into the exact v3 shape (defensive normalisation). */
function normaliseV3(raw: Record<string, unknown>): V3Result {
  const toArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x))
      : v
        ? String(v).split(/[\s,]+/).filter(Boolean)
        : [];

  const hashtags = toArr(raw.hashtags).map((h) => (h.startsWith("#") ? h : `#${h}`));
  const seo_keywords = Array.isArray(raw.seo_keywords)
    ? raw.seo_keywords.map((x) => String(x))
    : toArr(raw.seo_keywords);
  const alts = Array.isArray(raw.alternate_captions)
    ? raw.alternate_captions.map((x) => String(x || "").trim()).filter(Boolean)
    : [String(raw.best_caption || "")].filter(Boolean);

  const deref = (v: unknown, fallback: string): string => {
    const s = String(v || "").trim();
    const m = s.match(/^caption\s*([1-5])$/i);
    if (m) return alts[Number(m[1]) - 1] || fallback || "";
    if (/^(best|recommended)[_\s-]?caption$/i.test(s) || s.length < 15) return fallback || "";
    return s;
  };
  const best = deref(raw.best_caption, alts[0]) || alts[0] || "";
  const recommended = deref(raw.recommended_caption, best) || best || alts[0] || "";

  return {
    detected_business: str(raw.detected_business),
    detected_owner: str(raw.detected_owner),
    industry: str(raw.industry),
    main_topic: str(raw.main_topic),
    best_caption: best,
    alternate_captions: alts,
    hashtags,
    seo_keywords,
    cta: str(raw.cta),
    scores: (raw.scores as V3Result["scores"]) || {},
    recommended_caption: recommended,
  };
}

/** Deterministic v3 output when no API key is set (English only). */
function fallbackCaptionV3(brief: V3Brief): V3Result {
  const biz = brief.business_name || brief.logo_text || "our brand";
  const industry = brief.business_type || "business";
  const city = brief.city || "";
  const owner = brief.owner_name || "";
  const rawContent = (brief.video_summary || brief.video_script || "").trim();
  const firstLine =
    rawContent
      .split(/\r?\n/)
      .map((s) => s.replace(/^["“”\s]+|["“”\s]+$/g, "").trim())
      .filter(Boolean)[0] || "";
  const loc = city ? ` in ${city}` : "";
  const hook = (firstLine || `Looking for the best ${industry.toLowerCase()}${loc}?`).slice(0, 130);
  const brand = `${biz}${loc}`;
  const goal = brief.goal || "Engagement";
  const cta = ["Leads", "Appointments"].includes(goal)
    ? brief.phone
      ? `📞 Call us today: ${brief.phone}`
      : "📩 DM us to book your appointment"
    : goal === "Sales"
      ? "🛒 Order now — limited-time offer!"
      : "👉 Follow & DM us to know more";

  const styled = {
    professional: `${hook}\n\n${brand}${owner ? ` · ${owner}` : ""}\n${cta}`,
    emotional: `${hook}\n\nAt ${brand}, we make it happen for you. ✨\n${cta}`,
    engagement: `${hook}\n\n💬 Comment & share your thoughts 👇\n${brand}\n${cta}`,
    short: `${hook}\n${brand} · ${cta}`,
    sales: `${hook}\n\n🔥 Limited slots! ${cta}\n${brand}`,
  };
  const alts = [styled.professional, styled.emotional, styled.engagement, styled.short, styled.sales];

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hashtags = [
    ...new Set(
      [
        biz && `#${slug(biz)}`,
        owner && `#${slug(owner)}`,
        `#${slug(industry)}`,
        `#${slug(industry)}business`,
        `#${slug(industry)}nearme`,
        city && `#${slug(city)}`,
        city && `#${slug(city)}business`,
        "#trending",
        "#viral",
        "#reels",
        "#explore",
        "#localbusiness",
      ].filter(Boolean) as string[]
    ),
  ].slice(0, 13);

  const seo = [
    city ? `best ${industry} in ${city}` : `best ${industry}`,
    `${industry} near me`,
    `${industry} services`,
    `${industry} tips`,
    `${industry} consultation`,
  ].slice(0, 5);

  const sc = (e: number, s: number, l: number) => ({
    engagement: e,
    seo: s,
    lead_generation: l,
    overall: Math.round((e + s + l) / 3),
  });

  return {
    detected_business: biz,
    detected_owner: owner,
    industry,
    main_topic: hook.slice(0, 120),
    best_caption: alts[0],
    alternate_captions: alts,
    hashtags,
    seo_keywords: seo,
    cta,
    scores: {
      caption1: sc(92, 94, 93),
      caption2: sc(95, 90, 92),
      caption3: sc(96, 91, 90),
      caption4: sc(90, 92, 91),
      caption5: sc(93, 91, 95),
    },
    recommended_caption: alts[0],
    heuristic_note: "Set GEMINI_API_KEY for full AI captions (including Telugu / Tenglish).",
  };
}

async function generateCaptionV3(
  brief: V3Brief
): Promise<{ result: V3Result; provider: "openai" | "gemini" | "heuristic" }> {
  const { data, provider } = await callJSON(CAPTION_V3_SYSTEM, JSON.stringify(brief, null, 2));
  if (data && (data.best_caption || data.recommended_caption || data.alternate_captions)) {
    return { result: normaliseV3(data), provider: provider! };
  }
  return { result: fallbackCaptionV3(brief), provider: "heuristic" };
}

/* --------------------------- Composition --------------------------- */

const DIV = "-----------------------------------";

const handleOf = (link: string): string => {
  if (!link) return "";
  const m = link.match(/(?:instagram|facebook)\.com\/([^/?#]+)/i);
  const h = (m ? m[1] : link).replace(/^@+/, "").trim();
  return h ? `@${h}` : "";
};

/** Compose the final caption from the model result (mirrors ai.routes). */
function composeCaption(
  brief: V3Brief,
  r: V3Result,
  opts: { isPoster: boolean; includeContact: boolean }
): { caption: string; sections_below: string; hashtags: string } {
  const contactLines: string[] = [];
  if (opts.includeContact) {
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
  const contactBlock = contactLines.join("\n");

  const kwItems = [brief.business_name, brief.business_category, ...(r.seo_keywords || [])].filter(
    Boolean
  );
  const keywordBlock = `(${kwItems.join(", ")})`;

  let tags = (r.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`));
  const bizTag = brief.business_name ? `#${brief.business_name.replace(/[^A-Za-z0-9]+/g, "")}` : "";
  if (bizTag && !tags.some((t) => t.toLowerCase() === bizTag.toLowerCase())) tags = [bizTag, ...tags];
  const hashtagsStr = tags.join(" ");

  let sections_below: string;
  let caption: string;
  if (opts.isPoster) {
    const engBody = (r.alternate_captions || [])[2] || r.recommended_caption || r.best_caption || "";
    sections_below = [contactBlock, hashtagsStr].filter(Boolean).join("\n\n");
    caption = [engBody, sections_below].filter(Boolean).join("\n\n");
  } else {
    sections_below = [contactBlock, keywordBlock, hashtagsStr]
      .filter(Boolean)
      .join(`\n\n${DIV}\n\n`);
    caption = [r.recommended_caption || r.best_caption || "", sections_below]
      .filter(Boolean)
      .join(`\n\n${DIV}\n\n`);
  }
  return { caption, sections_below, hashtags: hashtagsStr };
}

/* ----------------------------- Public ------------------------------ */

/** Generate + compose a ready-to-post caption for a deliverable. */
export async function generateCaption(
  d: CaptionSource,
  opts: CaptionOptions = {}
): Promise<ComposedCaption> {
  const brief = v3Brief(d, opts);
  const { result, provider } = await generateCaptionV3(brief);
  const isPoster = str(d.video_type).toLowerCase() === "poster";
  const includeContact = opts.include_contact !== false;
  const { caption, sections_below, hashtags } = composeCaption(brief, result, {
    isPoster,
    includeContact,
  });
  return {
    provider,
    caption,
    sections_below,
    hashtags,
    cta: result.cta,
    alternate_captions: isPoster ? [] : result.alternate_captions,
    seo_keywords: result.seo_keywords,
    is_poster: isPoster,
  };
}
