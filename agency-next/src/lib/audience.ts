/**
 * How many people follow this client, on each platform.
 *
 * Ad numbers say what a campaign cost and what it returned. They say nothing
 * about whether the account it ran on is growing, which is the other half of
 * the question a client asks — and the half nobody could answer from the
 * portal without opening two apps.
 *
 * Read live rather than stored. A follower count is a number Meta already
 * holds and revises; keeping our own copy would mean a sync job, a staleness
 * question on every screen, and a second version of a fact that has exactly
 * one true value. When growth over time is wanted, that is a daily snapshot
 * table and a deliberate decision — not a side effect of showing a number.
 *
 * Never throws. This sits beside spend and impressions on a page whose real
 * job is the ad account, and a Graph call that fails must not take that page
 * down with it: every failure returns null and the caller renders nothing.
 */
import "server-only";
import { queryOne } from "./db";
import { env } from "./env";

const GRAPH = "https://graph.facebook.com";

export type Audience = {
  instagram: { username: string | null; followers: number } | null;
  facebook: { name: string | null; followers: number } | null;
};

type Row = {
  ig_user_id: string | null;
  ig_username: string | null;
  fb_page_id: string | null;
  ig_access_token: string | null;
};

/**
 * Both counts, in as few calls as the client's setup allows.
 *
 * A Page and the Instagram account linked to it can be read together —
 * `/{page-id}?fields=followers_count,instagram_business_account{followers_count}`
 * is one request for both numbers — so a client with a Page configured costs
 * one call rather than two. A client with only Instagram falls back to asking
 * the Instagram node directly.
 *
 * `followers_count` on a Page superseded `fan_count` (page likes), which is a
 * different and now-smaller number that Meta stopped surfacing in its own UI.
 * Both are requested and followers wins, so a Page on an older API version
 * still shows something rather than a dash.
 */
export async function getAudience(clientId: number): Promise<Audience | null> {
  const c = await queryOne<Row>(
    "SELECT ig_user_id, ig_username, fb_page_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  if (!c) return null;

  const token = c.ig_access_token || env.meta.accessToken;
  if (!token || (!c.ig_user_id && !c.fb_page_id)) return null;

  const v = env.meta.apiVersion;
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(
        `${GRAPH}/${v}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
        // Short, and on a page somebody is waiting for. A follower count is
        // worth having but never worth holding the ad figures back for.
        { cache: "no-store", signal: AbortSignal.timeout(6_000) }
      );
      const j = (await res.json().catch(() => ({}))) as T & { error?: unknown };
      return j.error ? null : j;
    } catch {
      return null;
    }
  };

  let instagram: Audience["instagram"] = null;
  let facebook: Audience["facebook"] = null;

  if (c.fb_page_id) {
    const page = await get<{
      name?: string;
      followers_count?: number;
      fan_count?: number;
      instagram_business_account?: { username?: string; followers_count?: number };
    }>(
      `/${c.fb_page_id}?fields=name,followers_count,fan_count,` +
        `instagram_business_account{username,followers_count}`
    );
    if (page) {
      const followers = page.followers_count ?? page.fan_count;
      if (typeof followers === "number") {
        facebook = { name: page.name ?? null, followers };
      }
      const ig = page.instagram_business_account;
      if (ig && typeof ig.followers_count === "number") {
        instagram = { username: ig.username ?? c.ig_username, followers: ig.followers_count };
      }
    }
  }

  // Either there is no Page, or the Page did not carry the linked account —
  // a client can have Instagram set up here without their Page id being
  // filled in, and that must still produce a number.
  if (!instagram && c.ig_user_id) {
    const ig = await get<{ username?: string; followers_count?: number }>(
      `/${c.ig_user_id}?fields=username,followers_count`
    );
    if (ig && typeof ig.followers_count === "number") {
      instagram = { username: ig.username ?? c.ig_username, followers: ig.followers_count };
    }
  }

  return instagram || facebook ? { instagram, facebook } : null;
}
