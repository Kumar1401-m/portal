/**
 * What the comments are actually saying.
 *
 * A client's post gets forty comments and somebody scrolls them on a phone once
 * a week. Two of those forty are a person asking the price, and those two are
 * the only ones that were ever worth reading — the rest is 🔥 and 👏. Missing
 * them is a lost customer that nobody records as a loss, because nobody knows
 * it happened.
 *
 * So this pulls the comments in and sorts them into six kinds, and the one that
 * matters is `lead`. Everything else on the board is context for it.
 *
 * **Classification is the model's; nothing else is.** It reads a comment and
 * says what kind it is — genuinely a language task, and one where Telugu,
 * Tenglish and emoji all arrive in the same thread. The counts, the ordering
 * and every figure on the board are computed here. And a suggested reply is
 * only ever a draft: nothing is ever posted to a client's account by this
 * portal, because a reply in the client's voice that nobody read is the one
 * mistake that cannot be taken back.
 */
import "server-only";
import { query, queryOne, execute, hasTable } from "./db";
import { env } from "./env";
import { callJSON } from "./ai";
import { getKnowledge, renderRules } from "./knowledge";
import {
  KINDS,
  NEEDS_A_PERSON,
  isKind,
  type Kind,
  type Comment,
  type SentimentBoard,
} from "./comment-kinds";

const GRAPH = "https://graph.facebook.com";

export const sentimentReady = () => hasTable("post_comments");

// The kinds live next door so the studio can read them without this module.
export {
  KINDS,
  KIND_LABEL,
  NEEDS_A_PERSON,
  isKind,
  type Kind,
  type Comment,
  type SentimentBoard,
} from "./comment-kinds";

const str = (v: unknown) => (v == null ? "" : String(v));

function mapRow(r: Record<string, unknown>): Comment {
  const k = str(r.sentiment);
  return {
    id: Number(r.id),
    commentId: str(r.comment_id),
    mediaId: str(r.media_id),
    username: r.username ? str(r.username) : null,
    text: str(r.text),
    postedAt: r.posted_at ? str(r.posted_at) : null,
    kind: isKind(k) ? k : null,
    suggestedReply: r.suggested_reply ? str(r.suggested_reply) : null,
    handled: Number(r.handled) === 1,
    permalink: r.permalink ? str(r.permalink) : null,
  };
}

/* ------------------------------ Fetching ------------------------------ */

/**
 * Pull comments for this client's recent posts.
 *
 * Only posts already in `post_insights`, so this rides on the sync that
 * already runs rather than asking Meta for the media list a second time.
 * Recent only: a comment on a post from March is not a lead anybody is going
 * to answer now, and fetching it costs a call.
 */
export async function syncComments(clientId: number, days = 30): Promise<{ ok: boolean; added: number; error?: string }> {
  if (!(await sentimentReady())) {
    return { ok: false, added: 0, error: "The post_comments table isn't in this database yet." };
  }

  const client = await queryOne<{ ig_access_token: string | null }>(
    "SELECT ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  const token = client?.ig_access_token || env.meta.accessToken;
  if (!token) return { ok: false, added: 0, error: "No Meta access token for this client." };

  const media = await query<{ media_id: string }>(
    `SELECT DISTINCT media_id FROM post_insights
      WHERE client_id = ? AND published_at >= CURDATE() - INTERVAL ? DAY
      ORDER BY published_at DESC LIMIT 25`,
    [clientId, Math.max(1, Math.trunc(days))]
  ).catch(() => []);

  if (!media.length) {
    return { ok: false, added: 0, error: "No recent posts to read comments on — sync Analytics first." };
  }

  let added = 0;
  for (const m of media) {
    try {
      const res = await fetch(
        `${GRAPH}/${env.meta.apiVersion}/${m.media_id}/comments` +
          `?fields=id,text,username,timestamp&limit=50&access_token=${encodeURIComponent(token)}`,
        { cache: "no-store", signal: AbortSignal.timeout(10_000) }
      );
      const json = (await res.json().catch(() => ({}))) as {
        data?: { id?: string; text?: string; username?: string; timestamp?: string }[];
        error?: unknown;
      };
      if (json.error || !Array.isArray(json.data)) continue;

      for (const c of json.data) {
        if (!c.id || !c.text) continue;
        const at = c.timestamp ? new Date(c.timestamp) : null;
        const r = await execute(
          `INSERT INTO post_comments (client_id, media_id, comment_id, username, text, posted_at)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE text = VALUES(text)`,
          [
            clientId,
            m.media_id,
            c.id,
            c.username?.slice(0, 190) ?? null,
            c.text.slice(0, 2000),
            at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 19).replace("T", " ") : null,
          ]
        );
        // affectedRows is 1 for an insert and 2 for an update on MySQL, which
        // is how a genuinely new comment is counted without a second query.
        if ((r.affectedRows ?? 0) === 1) added++;
      }
    } catch {
      // One post's comments failing is not the sync failing.
    }
  }

  return { ok: true, added };
}

/* ---------------------------- Classifying ---------------------------- */

/**
 * Sort the unclassified comments into kinds, in batches.
 *
 * Batched because one call per comment on a post with forty of them is forty
 * round trips for something a model can do in one. A batch that comes back the
 * wrong length is discarded rather than mapped positionally onto the wrong
 * comments — the id is carried through and matched, so a misaligned reply
 * cannot file somebody's complaint as praise.
 */
export async function classifyPending(clientId: number, limit = 40): Promise<{ classified: number }> {
  if (!(await sentimentReady())) return { classified: 0 };

  const rows = await query<Record<string, unknown>>(
    `SELECT id, text FROM post_comments
      WHERE client_id = ? AND sentiment IS NULL AND text <> ''
      ORDER BY posted_at DESC LIMIT ?`,
    [clientId, Math.max(1, Math.min(80, Math.trunc(limit)))]
  ).catch(() => []);
  if (!rows.length) return { classified: 0 };

  const knowledge = await getKnowledge(clientId).catch(() => null);
  const rules = knowledge ? renderRules(knowledge) : null;

  const { data } = await callJSON(
    [
      "You sort comments left on a business's social media posts.",
      `Give each one exactly one kind: ${KINDS.join(", ")}.`,
      "'lead' means they want to buy, book or know the price — this is the one that matters, do not file it as a question.",
      "'complaint' means they are unhappy with the business, not merely negative about the topic.",
      "Comments are often in Telugu, Tenglish or emoji. Judge the intent, not the language.",
      "Also draft a short reply the business could send, in the same language the comment used.",
      "Reply with JSON only.",
    ].join(" "),
    [
      rules ? `The business's rules for anything written in their voice:\n${rules}` : "",
      "Comments:",
      ...rows.map((r) => `${r.id}: ${String(r.text).slice(0, 400).replace(/\n/g, " ")}`),
      "",
      'Reply as JSON: { "results": [{"id": <the number above>, "kind": "lead", "reply": "a short draft reply"}] }',
      "One entry per comment, using the same id.",
    ]
      .filter(Boolean)
      .join("\n")
  ).catch(() => ({ data: null }));

  if (!data || !Array.isArray(data.results)) return { classified: 0 };

  const known = new Set(rows.map((r) => Number(r.id)));
  let classified = 0;

  for (const item of data.results as Record<string, unknown>[]) {
    const id = Number(item.id);
    const kind = String(item.kind ?? "").toLowerCase();
    // Matched by id, never by position, and only ids we actually sent.
    if (!known.has(id) || !isKind(kind)) continue;
    await execute("UPDATE post_comments SET sentiment = ?, suggested_reply = ? WHERE id = ?", [
      kind,
      String(item.reply ?? "").slice(0, 600) || null,
      id,
    ]).catch(() => undefined);
    classified++;
  }

  return { classified };
}

/* ------------------------------ Reading ------------------------------ */

export async function getBoard(clientId: number, days = 60): Promise<SentimentBoard> {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  const empty: SentimentBoard = {
    counts,
    total: 0,
    unclassified: 0,
    needsAttention: [],
    positiveShare: null,
  };
  if (!(await sentimentReady())) return empty;

  const rows = await query<Record<string, unknown>>(
    `SELECT c.*, p.permalink
       FROM post_comments c
       LEFT JOIN (SELECT media_id, MAX(permalink) AS permalink FROM post_insights GROUP BY media_id) p
         ON p.media_id = c.media_id
      WHERE c.client_id = ? AND (c.posted_at IS NULL OR c.posted_at >= CURDATE() - INTERVAL ? DAY)
      ORDER BY c.posted_at DESC
      LIMIT 500`,
    [clientId, Math.max(1, Math.trunc(days))]
  ).catch(() => []);

  const comments = rows.map(mapRow);
  let unclassified = 0;
  for (const c of comments) {
    if (c.kind) counts[c.kind]++;
    else unclassified++;
  }

  const classified = comments.length - unclassified;
  const rank = (k: Kind) => NEEDS_A_PERSON.indexOf(k);

  return {
    counts,
    total: comments.length,
    unclassified,
    needsAttention: comments
      .filter((c) => c.kind && NEEDS_A_PERSON.includes(c.kind) && !c.handled)
      .sort((a, b) => rank(a.kind!) - rank(b.kind!) || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
      .slice(0, 25),
    positiveShare: classified ? Math.round((counts.positive / classified) * 100) : null,
  };
}

export async function markHandled(clientId: number, id: number, handled: boolean): Promise<void> {
  await execute("UPDATE post_comments SET handled = ? WHERE id = ? AND client_id = ?", [
    handled ? 1 : 0,
    id,
    clientId,
  ]);
}

/**
 * The recurring themes, for the monthly conversation.
 *
 * Only run over what is already classified, and only when there is enough of
 * it — three comments do not have a theme, and printing one from three is how
 * a client is told their audience wants something two people mentioned.
 */
export async function themes(clientId: number): Promise<string[] | null> {
  if (!(await sentimentReady())) return null;
  const rows = await query<{ text: string; sentiment: string }>(
    `SELECT text, sentiment FROM post_comments
      WHERE client_id = ? AND sentiment IS NOT NULL AND text <> ''
      ORDER BY posted_at DESC LIMIT 120`,
    [clientId]
  ).catch(() => []);
  if (rows.length < 12) return null;

  const { data } = await callJSON(
    [
      "You find the recurring themes in comments left on a business's posts.",
      "Name only themes that appear more than once, and say roughly how often.",
      "Never invent a concern to fill a list. Three themes is a good answer; one is a fine answer.",
      "Reply with JSON only.",
    ].join(" "),
    [
      rows.map((r) => `[${r.sentiment}] ${r.text.slice(0, 200).replace(/\n/g, " ")}`).join("\n"),
      "",
      'Reply as JSON: { "themes": ["Several people ask about price before booking", "..."] }',
    ].join("\n")
  ).catch(() => ({ data: null }));

  const list = Array.isArray(data?.themes)
    ? (data!.themes as unknown[]).map((t) => String(t).trim()).filter(Boolean)
    : [];
  return list.length ? list : null;
}
