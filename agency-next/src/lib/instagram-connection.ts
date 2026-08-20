/**
 * Whether a client's Instagram is actually connected — asked, not assumed.
 *
 * The badge on the client page went green whenever `ig_user_id` was a
 * non-empty string. That is a check that somebody typed a number into a box,
 * and it answered the most important question on the page wrongly: a client
 * with a valid-looking id, no working token and nothing publishing showed
 * exactly the same green "Connected" as one that was posting every evening.
 *
 * The Facebook row beside it already spends a Graph call to earn its badge,
 * and its own comment names this row as the counter-example. This is that fix,
 * finished — the two now mean the same thing by the same method.
 *
 * Three failures it separates, all of which look identical from the column:
 *
 *   - no token anywhere, so nothing can publish for anybody
 *   - a Facebook **Page** id pasted into the Instagram field. It is the same
 *     shape, it looks completely correct, and it silently never publishes.
 *     Asking for `username` is what tells them apart: a Page has no username
 *     field, an Instagram Business account does.
 *   - a token that has expired, or was never given the publishing permission
 */
import "server-only";
import { queryOne } from "./db";
import { env } from "./env";

const GRAPH = "https://graph.facebook.com";

export type InstagramConnection =
  /** Meta answered for this account with this token. */
  | { state: "connected"; username: string | null }
  /** No account id on the client. Nothing is wrong; Instagram is simply off. */
  | { state: "off" }
  | { state: "broken"; reason: string };

/** Meta's errors, in words that name the fix. */
function explain(message: string | undefined, code: number | undefined): string {
  const m = message || "Instagram did not answer.";
  if (code === 190) {
    return "The Meta access token has expired or been revoked. Generate a new one and save it.";
  }
  if (code === 100 || /nonexisting field|does not exist|cannot be loaded/i.test(m)) {
    return (
      "That id is not an Instagram Business account. A Facebook Page id looks identical and is " +
      "the usual mix-up — the Instagram one is on the Page's linked account, not the Page itself."
    );
  }
  if (code === 200 || /permission/i.test(m)) {
    return `${m} The token needs instagram_basic and instagram_content_publish for this account.`;
  }
  return m;
}

export async function checkInstagramConnection(clientId: number): Promise<InstagramConnection> {
  const row = await queryOne<{ ig_user_id: string | null; ig_access_token: string | null }>(
    "SELECT ig_user_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  const igId = row?.ig_user_id?.trim();
  if (!igId) return { state: "off" };

  // Per client first, then the agency-wide one — the same order the publisher
  // resolves it in, so this badge cannot be right about a token the publish
  // would not have used.
  const token = row?.ig_access_token || env.meta.accessToken;
  if (!token) {
    return {
      state: "broken",
      reason:
        "No Meta access token. Set META_ACCESS_TOKEN, or paste this client's token on their edit page. " +
        "Nothing publishes until one exists.",
    };
  }

  try {
    const res = await fetch(
      `${GRAPH}/${env.meta.apiVersion}/${igId}?fields=username&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) }
    );
    const json = (await res.json().catch(() => ({}))) as {
      username?: string;
      error?: { message?: string; code?: number };
    };

    if (json.error) return { state: "broken", reason: explain(json.error.message, json.error.code) };
    /*
     * A 200 with no username is the Page-id case.
     *
     * Meta answers for a Page id here rather than erroring — it simply returns
     * an object without the field. Treated as connected, that is precisely the
     * green badge on a client who never publishes that this module exists to
     * stop.
     */
    if (!json.username) {
      return {
        state: "broken",
        reason:
          "Meta knows that id but it has no Instagram username, which means it is a Facebook Page " +
          "rather than an Instagram Business account. Publishing will silently never happen.",
      };
    }
    return { state: "connected", username: json.username };
  } catch (err) {
    return {
      state: "broken",
      reason: err instanceof Error ? err.message : "Instagram did not answer.",
    };
  }
}
