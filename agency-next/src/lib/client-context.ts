/**
 * What the AI needs to know about a client before it writes their caption.
 *
 * A caption written from the video alone describes the video. A caption
 * written with the business behind it can name the service, the city and the
 * offer — which is the difference between a description and marketing copy.
 *
 * Three sources, cheapest and most authoritative first:
 *
 *   1. The client record. Already ours, always available, and the agency put
 *      it there deliberately.
 *   2. The Instagram bio, via the Graph API. This is where the "name |
 *      designation" line lives — "venky | loan provider" says more in four
 *      words than a paragraph of guessing.
 *   3. The client's own website. Authoritative when it resolves; plenty don't.
 *
 * Web search is deliberately NOT one of them by default: Gemini's grounding is
 * a paid-tier feature, and everything above is the client's own words anyway.
 * `groundingAvailable` is the switch for when billing is on.
 */
import "server-only";
import { queryOne, query } from "./db";
import { env } from "./env";

export type ClientContext = {
  clientId: number;
  name: string;
  businessType: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  instagramHandle: string | null;
  /** From the IG profile — usually "Name | What they do". */
  instagramBio: string | null;
  followers: number | null;
  services: string[];
  /** Text pulled from the client's own site, trimmed. */
  websiteSummary: string | null;
  /** Logo/watermark cues previously confirmed for this client. */
  knownBrandCues: string[];
  /** Where each piece came from — shown to whoever audits a caption. */
  sources: string[];
};

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

/**
 * Fetch a page and reduce it to readable text.
 *
 * Capped hard and given a short timeout: a client's website is a nice-to-have,
 * and a slow or enormous one must not hold up a caption. Scripts and styles
 * are stripped first — they are most of the bytes and none of the meaning.
 */
async function readWebsite(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgencyPortal/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html")) return null;

    const html = (await res.text()).slice(0, 400_000);
    const meta =
      html.match(/name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ||
      html.match(/property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ||
      "";
    const title = html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() || "";

    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const combined = [title, meta, body].filter(Boolean).join(" — ");
    return combined ? combined.slice(0, 1200) : null;
  } catch {
    // A dead or slow site is normal and not worth reporting as an error.
    return null;
  }
}

/**
 * The client's Instagram bio, straight from the Graph API.
 *
 * Preferred over scraping the profile page: it is the supported route, it
 * doesn't break when Instagram changes its markup, and it returns the bio as
 * a field rather than buried in a meta tag.
 */
async function readInstagramProfile(
  igUserId: string,
  token: string
): Promise<{ bio: string | null; handle: string | null; followers: number | null; website: string | null }> {
  try {
    const url =
      `https://graph.facebook.com/${env.meta.apiVersion}/${igUserId}` +
      `?fields=username,name,biography,website,followers_count&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const j = (await res.json()) as {
      username?: string;
      name?: string;
      biography?: string;
      website?: string;
      followers_count?: number;
      error?: unknown;
    };
    if (j.error) return { bio: null, handle: null, followers: null, website: null };

    // `name` is the display line ("venky | loan provider"); the biography is
    // the longer text under it. Both are useful, so both are kept.
    const bio = [str(j.name), str(j.biography)].filter(Boolean).join(" — ") || null;
    return {
      bio,
      handle: str(j.username),
      followers: typeof j.followers_count === "number" ? j.followers_count : null,
      website: str(j.website),
    };
  } catch {
    return { bio: null, handle: null, followers: null, website: null };
  }
}

/** Handle out of an instagram.com URL, for clients with no connected account. */
function handleFromLink(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  return m ? m[1].replace(/\/$/, "") : null;
}

/**
 * Assemble everything known about a client.
 *
 * Every external lookup is optional and independently failure-tolerant: with
 * no Meta token and a dead website this still returns the record, which is
 * enough to write a decent caption.
 */
export async function getClientContext(clientId: number): Promise<ClientContext | null> {
  const c = await queryOne<{
    id: number;
    company_name: string;
    business_type: string | null;
    phone: string | null;
    website: string | null;
    instagram_link: string | null;
    ig_user_id: string | null;
    ig_username: string | null;
    ig_access_token: string | null;
    services: unknown;
    placeholder_values: unknown;
  }>(
    `SELECT id, company_name, business_type, phone, website, instagram_link,
            ig_user_id, ig_username, ig_access_token, services, placeholder_values
       FROM clients WHERE id = ?`,
    [clientId]
  );
  if (!c) return null;

  const ph = asObj(c.placeholder_values);
  const sources = ["client record"];

  const ctx: ClientContext = {
    clientId: c.id,
    name: c.company_name,
    businessType: c.business_type,
    city: str(ph.location),
    country: str(ph.country),
    phone: c.phone || str(ph.phone),
    website: c.website,
    instagramHandle: c.ig_username || handleFromLink(c.instagram_link),
    instagramBio: null,
    followers: null,
    services: Array.isArray(c.services)
      ? (c.services as string[])
      : typeof c.services === "string"
        ? (JSON.parse(c.services || "[]") as string[])
        : [],
    websiteSummary: null,
    knownBrandCues: [],
    sources,
  };

  // Cues an admin has previously confirmed belong to this client — the exact
  // strings its logo and watermark carry.
  try {
    const cues = await query<{ cue_value: string }>(
      "SELECT cue_value FROM client_fingerprints WHERE client_id = ? LIMIT 20",
      [clientId]
    );
    ctx.knownBrandCues = cues.map((x) => x.cue_value).filter(Boolean);
    if (ctx.knownBrandCues.length) sources.push("known brand cues");
  } catch {
    // Table predates some installs; absence is not an error.
  }

  // Both external lookups run together — neither depends on the other, and a
  // slow website shouldn't delay the Instagram read.
  const token = c.ig_access_token || env.meta.accessToken;
  const [ig, site] = await Promise.all([
    c.ig_user_id && token
      ? readInstagramProfile(c.ig_user_id, token)
      : Promise.resolve({ bio: null, handle: null, followers: null, website: null }),
    c.website && /^https?:\/\//i.test(c.website)
      ? readWebsite(c.website)
      : Promise.resolve(null),
  ]);

  if (ig.bio) {
    ctx.instagramBio = ig.bio;
    ctx.followers = ig.followers;
    if (ig.handle) ctx.instagramHandle = ig.handle;
    // The IG bio often carries a website the client record doesn't have.
    if (!ctx.website && ig.website) ctx.website = ig.website;
    sources.push("Instagram profile");
  }
  if (site) {
    ctx.websiteSummary = site;
    sources.push("client website");
  }

  /*
   * Say so when the bio was skipped rather than merely absent.
   *
   * The Instagram bio is where the "name | what they do" line lives, and it is
   * the single most useful sentence about a client. Without this note a
   * missing bio and an unconfigured token look identical in the audit trail —
   * and only one of them is fixable.
   */
  if (!ctx.instagramBio && c.ig_user_id && !token) {
    sources.push("Instagram bio unavailable — no Meta access token configured");
  }

  return ctx;
}

/* ---------------------------- Contact-detail safety --------------------------- */

/** A phone number reduced to the last 10 digits, so formatting stops mattering. */
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Every phone-shaped run in a block of text, normalised. */
function phonesIn(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/\+?\d[\d\s\-()]{8,}\d/g)) {
    const n = normalisePhone(m[0]);
    if (n) out.push(n);
  }
  return out;
}

/**
 * The phone numbers this client can legitimately be reached on.
 *
 * Everything the business has published about itself counts — the record, the
 * bio, the website, and whatever the video puts on screen. Anything outside
 * this set that turns up in a caption was invented.
 */
export function allowedPhones(ctx: ClientContext | null, seenOnVideo?: string | null): Set<string> {
  const set = new Set<string>();
  if (!ctx) return set;
  for (const source of [
    ctx.phone,
    ctx.instagramBio,
    ctx.websiteSummary,
    seenOnVideo ?? null,
    ...ctx.knownBrandCues,
  ]) {
    for (const p of phonesIn(source)) set.add(p);
  }
  return set;
}

/**
 * Replace any phone number in a caption that the client doesn't actually own.
 *
 * A language model asked to end with a call to action will happily produce a
 * plausible ten-digit number when it hasn't been given one — and it reads
 * exactly like a real one. For a loan consultancy that is not a cosmetic
 * error: it is a caption telling borrowers to ring a stranger.
 *
 * Prompting alone doesn't close this, so the output is checked. A number we
 * can correct is corrected; one we can't is removed along with the line it sat
 * in, because half a call to action is worse than none.
 */
export function correctPhones(
  caption: string,
  allowed: Set<string>,
  preferred: string | null
): { caption: string; changed: number } {
  const good = preferred && normalisePhone(preferred) ? preferred.trim() : null;

  // Written as an escape rather than a raw control byte, which would be
  // invisible in the source. It has to be a character the model could never
  // produce — a printable marker would match half the caption.
  const DROP = "\u0000";
  let changed = 0;

  const fixed = caption.replace(/\+?\d[\d\s\-()]{8,}\d/g, (match) => {
    const n = normalisePhone(match);
    if (!n || allowed.has(n)) return match;
    changed++;
    return good ?? DROP; // nothing real to swap in — drop the line instead
  });

  if (!changed) return { caption, changed: 0 };

  const cleaned = fixed
    .split("\n")
    .filter((line) => !line.includes(DROP))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { caption: cleaned, changed };
}

/** Is grounded web search available? Paid Gemini tier only. */
export function groundingAvailable(): boolean {
  return String(process.env.GEMINI_GROUNDING || "").toLowerCase() === "true";
}

/**
 * Render the context as the block handed to the model.
 *
 * Plain labelled lines rather than JSON: the model reads it as briefing
 * material, and anything absent is simply omitted so it is never invited to
 * fill a blank field with a plausible invention.
 */
export function renderContext(ctx: ClientContext): string {
  const lines = [
    `Business: ${ctx.name}`,
    ctx.businessType ? `Type: ${ctx.businessType}` : null,
    ctx.instagramBio ? `How they describe themselves: ${ctx.instagramBio}` : null,
    ctx.instagramHandle ? `Instagram: @${ctx.instagramHandle}` : null,
    ctx.followers ? `Followers: ${ctx.followers}` : null,
    [ctx.city, ctx.country].filter(Boolean).length
      ? `Location: ${[ctx.city, ctx.country].filter(Boolean).join(", ")}`
      : null,
    ctx.phone ? `Phone: ${ctx.phone}` : null,
    ctx.website ? `Website: ${ctx.website}` : null,
    ctx.services.length ? `Services we provide them: ${ctx.services.join(", ")}` : null,
    ctx.knownBrandCues.length
      ? `Their branding usually shows: ${ctx.knownBrandCues.join(", ")}`
      : null,
    ctx.websiteSummary ? `From their website: ${ctx.websiteSummary}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}
