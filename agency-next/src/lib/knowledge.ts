/**
 * What the agency knows about a client's brand, written down once.
 *
 * The AI already reads a client's record, their Instagram bio and their
 * website — that is `client-context.ts`, and it is why a caption can name the
 * service and the city. What it could never know is the part that lives in
 * somebody's head: that this client says "clients" and never "customers",
 * that they will not make medical claims, that their CTA is always the
 * WhatsApp number and never the website, that their brand is bottle green.
 *
 * Every generated caption was therefore slightly wrong in the same way every
 * month, and somebody fixed it by hand every month.
 *
 * **Facts and rules are kept apart, deliberately.** `client-context.ts`
 * already makes that distinction for the caption template, and the reasoning
 * holds here: a fact is offered to the model to use or ignore as the work
 * warrants, and a rule is not negotiable. Mixing them is how "never say cure"
 * becomes a suggestion.
 *
 * One row per client, plain text fields. Not a table of terms and a table of
 * CTAs and a join — this is edited in a textarea by a person who is thinking
 * about the client, and a line per item is the shape that survives that.
 */
import "server-only";
import { queryOne, execute, hasTable } from "./db";

export const knowledgeReady = () => hasTable("client_knowledge");

export type Knowledge = {
  clientId: number;
  /** Who the content is talking to. */
  audience: string | null;
  /** How it should sound — "warm, plain Telugu, never salesy". */
  tone: string | null;
  /** Brand colours, however the agency wrote them down. */
  brandColors: string | null;
  /** Words to use. One per line. */
  approvedTerms: string[];
  /** Words never to use. One per line. */
  bannedTerms: string[];
  /** Hard rules — no medical claims, no competitor names, no prices. */
  restrictions: string[];
  /** The calls to action this client actually uses. */
  ctas: string[];
  /** Anything else worth telling whoever writes for them. */
  notes: string | null;
  updatedAt: string | null;
};

/** Lines out of a textarea: trimmed, blanks dropped, bullet characters removed. */
export function lines(v: string | null | undefined): string[] {
  return String(v ?? "")
    .split("\n")
    .map((s) => s.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

const str = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

export const emptyKnowledge = (clientId: number): Knowledge => ({
  clientId,
  audience: null,
  tone: null,
  brandColors: null,
  approvedTerms: [],
  bannedTerms: [],
  restrictions: [],
  ctas: [],
  notes: null,
  updatedAt: null,
});

export async function getKnowledge(clientId: number): Promise<Knowledge> {
  if (!(await knowledgeReady())) return emptyKnowledge(clientId);
  const r = await queryOne<Record<string, unknown>>(
    "SELECT * FROM client_knowledge WHERE client_id = ?",
    [clientId]
  ).catch(() => null);
  if (!r) return emptyKnowledge(clientId);

  return {
    clientId,
    audience: str(r.audience),
    tone: str(r.tone),
    brandColors: str(r.brand_colors),
    approvedTerms: lines(r.approved_terms as string),
    bannedTerms: lines(r.banned_terms as string),
    restrictions: lines(r.restrictions as string),
    ctas: lines(r.ctas as string),
    notes: str(r.notes),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export type KnowledgeInput = {
  audience?: string | null;
  tone?: string | null;
  brandColors?: string | null;
  approvedTerms?: string | null;
  bannedTerms?: string | null;
  restrictions?: string | null;
  ctas?: string | null;
  notes?: string | null;
};

export async function saveKnowledge(
  clientId: number,
  input: KnowledgeInput,
  by?: number | null
): Promise<void> {
  // Stored as the text it was typed as, split only on the way out. What
  // somebody wrote is what they see when they come back to edit it.
  const cap = (v: string | null | undefined, max: number) => (v ?? "").trim().slice(0, max) || null;

  await execute(
    `INSERT INTO client_knowledge
       (client_id, audience, tone, brand_colors, approved_terms, banned_terms,
        restrictions, ctas, notes, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       audience = VALUES(audience), tone = VALUES(tone), brand_colors = VALUES(brand_colors),
       approved_terms = VALUES(approved_terms), banned_terms = VALUES(banned_terms),
       restrictions = VALUES(restrictions), ctas = VALUES(ctas), notes = VALUES(notes),
       updated_by = VALUES(updated_by)`,
    [
      clientId,
      cap(input.audience, 500),
      cap(input.tone, 300),
      cap(input.brandColors, 200),
      cap(input.approvedTerms, 2000),
      cap(input.bannedTerms, 2000),
      cap(input.restrictions, 2000),
      cap(input.ctas, 2000),
      cap(input.notes, 4000),
      by ?? null,
    ]
  );
}

/** Nothing filled in at all — the caller shows a prompt rather than a blank card. */
export const isEmpty = (k: Knowledge): boolean =>
  !k.audience &&
  !k.tone &&
  !k.brandColors &&
  !k.notes &&
  !k.approvedTerms.length &&
  !k.bannedTerms.length &&
  !k.restrictions.length &&
  !k.ctas.length;

/** How much of it is filled in, for the nudge on the client's page. */
export function completeness(k: Knowledge): number {
  const filled = [
    k.audience,
    k.tone,
    k.brandColors,
    k.approvedTerms.length ? "y" : null,
    k.bannedTerms.length ? "y" : null,
    k.restrictions.length ? "y" : null,
    k.ctas.length ? "y" : null,
  ].filter(Boolean).length;
  return Math.round((filled / 7) * 100);
}

/* --------------------------- For the model --------------------------- */

/**
 * The facts half — who they talk to, how they sound, what they look like.
 *
 * Offered as briefing material and folded in beside the rest of the client
 * context, so anything absent is simply not mentioned. A blank line inviting
 * the model to invent a target audience is worse than no line.
 */
export function renderKnowledge(k: Knowledge): string | null {
  const out = [
    k.audience ? `Who this content is for: ${k.audience}` : null,
    k.tone ? `How it should sound: ${k.tone}` : null,
    k.brandColors ? `Brand colours: ${k.brandColors}` : null,
    k.approvedTerms.length ? `Words this client uses: ${k.approvedTerms.join(", ")}` : null,
    k.ctas.length ? `Calls to action they use: ${k.ctas.join(" / ")}` : null,
    k.notes ? `Worth knowing: ${k.notes}` : null,
  ].filter(Boolean);
  return out.length ? out.join("\n") : null;
}

/**
 * The rules half — what must not happen, phrased as requirements.
 *
 * Its own headed block rather than another line in the briefing, because the
 * two are read differently. A banned word inside a list of facts is a fact
 * about the client; a banned word under "these are not negotiable" is an
 * instruction. That difference is the whole reason this function is separate,
 * and it is the same reasoning the caption template already uses.
 */
export function renderRules(k: Knowledge): string | null {
  const rules: string[] = [];

  if (k.bannedTerms.length) {
    rules.push(
      `Never use these words or phrases: ${k.bannedTerms.join(", ")}. ` +
        `Not as a variation, not in a hashtag, not in the CTA.`
    );
  }
  for (const r of k.restrictions) rules.push(r);
  if (k.ctas.length) {
    rules.push(
      `The call to action must be one of the client's own: ${k.ctas.join(" / ")}. ` +
        `Do not invent a new one.`
    );
  }

  if (!rules.length) return null;

  return [
    "THE CLIENT'S RULES — THESE ARE NOT OPTIONAL",
    "",
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    "",
    "If a rule and the video disagree, follow the rule and leave the detail out.",
  ].join("\n");
}
