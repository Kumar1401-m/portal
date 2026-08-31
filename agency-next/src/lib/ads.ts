/**
 * What the ads actually cost, read from Meta rather than typed by anyone.
 *
 * "Accurate" is the whole requirement here, and it decides every choice below.
 *
 *   - **Nothing is entered by hand.** Spend, impressions and leads come from
 *     the Marketing API's own insights for the client's ad account. A number
 *     somebody typed at the end of the month is a number nobody can check.
 *
 *   - **Stored per day, not per period.** One row per client per day, upserted.
 *     A month total pulled once cannot be re-sliced, cannot be compared with
 *     last week, and silently freezes the day Meta restates a figure — which
 *     it does, for up to 28 days, as attribution settles. Daily rows re-sync
 *     and correct themselves.
 *
 *   - **Missing is not zero.** A client with no ad account connected shows as
 *     not connected. Rendering ₹0 spend for them would put a real-looking
 *     zero next to real numbers, and zero is the one figure nobody questions.
 *
 *   - **Currencies are never added together.** Meta reports in the ad
 *     account's own currency. Summing INR and USD into one "total spend" is
 *     the kind of wrong that looks right.
 *
 *   - **Cost per lead is null, not zero, when there are no leads.** Dividing
 *     by nothing is not free acquisition.
 */
import "server-only";
import { query, queryOne, execute, hasColumn, hasTable } from "./db";
import { env } from "./env";

/** Meta restates conversions for up to 28 days, so a re-sync must reach back. */
export const RESTATEMENT_DAYS = 28;

/**
 * Which of Meta's action types counts as a lead.
 *
 * They overlap: a single form fill can appear as `lead`, as
 * `onsite_conversion.lead_grouped` and as a pixel conversion all at once, so
 * adding them up multiplies one lead into three. Highest-confidence first, and
 * the first one present wins — a defensible single number rather than a
 * flattering total.
 */
const LEAD_ACTIONS = [
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "leadgen.other",
] as const;

/**
 * The other three things a client actually asks about.
 *
 * Spend is the agency's number. What the client wants to know is who came:
 * how many clicked through, how many watched, how many went and looked at the
 * profile afterwards. None of those were being kept — the sync read `actions`
 * for leads and threw the rest away.
 *
 * Same overlapping-types problem as leads, so the same rule: candidates in
 * order of confidence, first one present wins. Meta names Instagram profile
 * visits differently across account and API versions, which is exactly why
 * this is a list and not a string.
 */
const CLICK_ACTIONS = ["link_click"] as const;
const ENGAGEMENT_ACTIONS = ["post_engagement", "page_engagement"] as const;
const VIDEO_VIEW_ACTIONS = ["video_view"] as const;
const PROFILE_VISIT_ACTIONS = [
  "onsite_conversion.ig_profile_visit",
  "instagram_profile_visit",
  "profile_visit",
] as const;

export type AdDay = {
  client_id: number;
  date: string;
  spend: number;
  currency: string;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
};

export async function adsReadiness(): Promise<{ ready: boolean; reason?: string }> {
  if (!(await hasTable("ad_insights"))) {
    return {
      ready: false,
      reason:
        "The ad_insights table is missing. Run database/migrate.js, or apply it from Settings → Database.",
    };
  }
  if (!(await hasColumn("clients", "meta_ad_account_id"))) {
    return { ready: false, reason: "The meta_ad_account_id column is missing." };
  }
  return { ready: true };
}

/** `act_123` however it was pasted — with or without the prefix, spaces and all. */
export function normaliseAccountId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  const digits = s.replace(/^act_/i, "");
  if (!/^\d{5,}$/.test(digits)) return null;
  return `act_${digits}`;
}

/**
 * The one lead figure for a day, out of Meta's overlapping action types.
 *
 * Exported because it is the number the whole dashboard's credibility rests
 * on, and a rule this easy to get wrong should be testable on its own.
 */
export function leadsFromActions(
  actions: { action_type?: string; value?: string | number }[] | undefined
): number {
  return actionCount(actions, LEAD_ACTIONS) ?? 0;
}

/**
 * One figure out of Meta's overlapping action types, or null.
 *
 * Null and zero are different facts and the difference is the whole point:
 * "Meta did not report this at all" is not "nobody did it". A client shown a
 * confident 0 profile visits would conclude the ad was ignored, when the truth
 * may be that this account never reports that action type. A dash says what we
 * actually know.
 *
 * Leads keep coercing to 0 because every screen and every stored column has
 * treated a missing lead figure as none since before this existed, and a
 * nullable lead count would ripple through cost-per-lead everywhere.
 */
export function actionCount(
  actions: { action_type?: string; value?: string | number }[] | undefined,
  types: readonly string[]
): number | null {
  if (!Array.isArray(actions)) return null;
  for (const type of types) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) return Math.max(0, Math.trunc(Number(hit.value) || 0));
  }
  return null;
}

/** What a client is shown instead of spend: who clicked, who watched, who looked. */
export function reachedFromActions(
  actions: { action_type?: string; value?: string | number }[] | undefined
): {
  linkClicks: number | null;
  videoViews: number | null;
  profileVisits: number | null;
  engagement: number | null;
} {
  return {
    linkClicks: actionCount(actions, CLICK_ACTIONS),
    videoViews: actionCount(actions, VIDEO_VIEW_ACTIONS),
    profileVisits: actionCount(actions, PROFILE_VISIT_ACTIONS),
    engagement: actionCount(actions, ENGAGEMENT_ACTIONS),
  };
}

/**
 * Reach for the whole window, and whether each ad is still delivering.
 *
 * Two things the daily rows cannot give.
 *
 * **Reach** is people, not events. The same person reached on Monday and
 * Tuesday is one person, so adding the daily figures produces a bigger number
 * that looks exactly like the right one — and nothing about stored daily rows
 * can recover the true figure. Asking Meta for the window *without*
 * `time_increment` returns the deduplicated count, which is the number Ads
 * Manager itself shows.
 *
 * **Status** is not an insights field at all; it lives on the ad object. Both
 * are one request each for the whole account, not one per ad.
 *
 * Best-effort throughout: this runs after everything that matters is stored,
 * so a failure costs two columns and nothing else.
 */
async function adWindowExtras(
  account: string,
  token: string,
  since: string,
  until: string
): Promise<Map<string, { reach: number | null; status: string | null }>> {
  const out = new Map<string, { reach: number | null; status: string | null }>();

  try {
    const url =
      `https://graph.facebook.com/${env.meta.apiVersion}/${account}/insights` +
      `?fields=ad_id,reach&level=ad` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
      `&limit=500&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as { data?: { ad_id?: string; reach?: string }[] };
    for (const r of json.data ?? []) {
      if (!r.ad_id) continue;
      out.set(String(r.ad_id), { reach: Math.trunc(Number(r.reach) || 0), status: null });
    }
  } catch {
    // The daily rows are already stored; reach is the nicest column here and
    // the least important.
  }

  try {
    const url =
      `https://graph.facebook.com/${env.meta.apiVersion}/${account}/ads` +
      `?fields=id,effective_status&limit=500&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as { data?: { id?: string; effective_status?: string }[] };
    for (const a of json.data ?? []) {
      if (!a.id) continue;
      const at = out.get(String(a.id)) ?? { reach: null, status: null };
      at.status = a.effective_status ?? null;
      out.set(String(a.id), at);
    }
  } catch {
    // Same again.
  }

  return out;
}

/**
 * What to actually do about a Meta error, in one line.
 *
 * Meta's own message is kept — it is precise and it is what a search engine
 * will match — but on its own it names the symptom and not the cure. "#200 Ad
 * account owner has NOT grant ads_read" reads as "ask the client for
 * permission", when nine times out of ten the token is simply the wrong kind
 * and there is nothing to ask anybody for.
 *
 * Exported so the test can hold the mapping to the codes Meta documents rather
 * than to whatever this function happens to do.
 */
export function fixFor(code: number | undefined, message: string): string | undefined {
  const m = message.toLowerCase();

  if (code === 200 || code === 10 || code === 272 || m.includes("ads_read")) {
    return (
      "The token cannot read this ad account. It needs to be a User or System User token with " +
      "the ads_read permission — a Page or Instagram token will never work, whatever is granted " +
      "to it. In Business Settings → Users → System Users, assign that user to this ad account " +
      "(View Performance is enough), generate a token with ads_read, and paste it in."
    );
  }
  if (code === 190) {
    return (
      "The token has expired or been revoked. Generate a new one and paste it in — a System User " +
      "token does not expire, which is why it is worth using here."
    );
  }
  if (code === 803 || m.includes("does not exist") || m.includes("unsupported get request")) {
    return (
      "Meta cannot see an ad account with that id. Check the act_… number against Ads Manager — " +
      "it is the ad account id, not the Page id or the Instagram account id."
    );
  }
  if (code === 4 || code === 17 || code === 613 || m.includes("rate limit")) {
    return "Meta is rate limiting us. Nothing to fix — the nightly run will pick it up.";
  }
  return undefined;
}

/**
 * Ask Meta what a token can actually do.
 *
 * Called only after a permission error, never on the happy path — it is a
 * second round trip, and the point of it is to tell two very similar failures
 * apart. "#200 Missing Permissions" is returned both when the token lacks the
 * `ads_read` scope and when the token has it but its owner was never given the
 * ad account. The fix is completely different, and the message is identical.
 *
 * Silent on failure: this exists to improve an error, and an error while
 * improving an error is not worth showing anybody.
 */
async function tokenScopes(token: string): Promise<{ type?: string; scopes: string[] } | null> {
  try {
    const url =
      `https://graph.facebook.com/${env.meta.apiVersion}/debug_token` +
      `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { type?: string; scopes?: string[] } };
    if (!j.data) return null;
    return { type: j.data.type, scopes: j.data.scopes ?? [] };
  } catch {
    return null;
  }
}

type InsightRow = {
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  account_currency?: string;
  actions?: { action_type?: string; value?: string }[];
};

/**
 * Pull one client's daily insights and store them.
 *
 * `time_increment=1` is what makes Meta return a row per day rather than one
 * total for the range — the difference between data you can slice afterwards
 * and a single number you have to trust.
 *
 * Returns what happened rather than throwing: one client's revoked token must
 * not fail the sync for every other client.
 */
export async function syncClientAds(
  clientId: number,
  days = RESTATEMENT_DAYS
): Promise<{ ok: boolean; rows: number; error?: string; hint?: string }> {
  const hasAdsToken = await hasColumn("clients", "ads_access_token");
  const c = await queryOne<{
    id: number;
    company_name: string;
    meta_ad_account_id: string | null;
    ads_access_token: string | null;
  }>(
    `SELECT id, company_name, meta_ad_account_id,
            ${hasAdsToken ? "ads_access_token" : "NULL AS ads_access_token"}
       FROM clients WHERE id = ?`,
    [clientId]
  );
  if (!c) return { ok: false, rows: 0, error: "Client not found." };

  const account = normaliseAccountId(c.meta_ad_account_id);
  if (!account) return { ok: false, rows: 0, error: "No ad account connected." };

  /*
   * The client's own ads token, else the agency's. Never the Page token.
   *
   * This used to fall back to `ig_access_token`, and that was the bug behind
   * every "(#200) Ad account owner has NOT grant ads_read" anyone saw: a Page
   * token cannot read an ad account at all, no matter what permissions are
   * granted to it, so the request was certain to fail and the message pointed
   * at the ad account rather than at the token being the wrong kind.
   */
  const token = (c.ads_access_token || "").trim() || env.meta.adsAccessToken.trim();
  if (!token) {
    return {
      ok: false,
      rows: 0,
      error: "No ads token configured.",
      hint:
        "Reading spend needs a User or System User token with the ads_read permission — a Page " +
        "token cannot do it. Add one as META_ADS_ACCESS_TOKEN, or per client on their edit page.",
    };
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  const url =
    `https://graph.facebook.com/${env.meta.apiVersion}/${account}/insights` +
    `?fields=spend,impressions,reach,clicks,account_currency,actions` +
    `&time_increment=1&level=account` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  let payload: { data?: InsightRow[]; error?: { message?: string; code?: number } };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    payload = (await res.json()) as typeof payload;
    if (!res.ok || payload.error) {
      // Meta's own words, kept verbatim — they are precise and searchable —
      // with the fix alongside, because the message names the symptom.
      const message = payload.error?.message || `HTTP ${res.status}`;
      const code = payload.error?.code;

      /*
       * A permission error is two different problems wearing one message, so
       * ask the token which one it is before guessing. Missing scope and
       * missing asset assignment both come back as "#200 Missing Permissions",
       * and sending someone to fix the wrong one costs an afternoon.
       */
      let hint = fixFor(code, message);
      if (code === 200 || code === 10 || code === 272) {
        const info = await tokenScopes(token);
        if (info && !info.scopes.includes("ads_read")) {
          hint =
            `This token has no ads_read permission — its scopes are ${info.scopes.join(", ") || "none"}. ` +
            `Regenerate it with ads_read ticked` +
            (info.type === "SYSTEM_USER"
              ? " (Business Settings → Users → System Users → Generate New Token)."
              : ".") +
            /*
             * The step before that one, and the one that stops people: the
             * token generator only offers scopes belonging to products the app
             * has. With no Marketing API on the app, ads_read is not in the
             * list to tick and there is nothing on that screen saying why.
             */
            " If ads_read is not in the list, the app has not got the Marketing API product yet —" +
            " add it in the App Dashboard first, then come back and generate the token." +
            " The ad account assignment is separate and also needed: assign that user to the ad" +
            " account with at least View Performance.";
        } else if (info?.scopes.includes("ads_read")) {
          hint =
            "The token does carry ads_read, so the scope is not the problem — this user has not " +
            "been given the ad account. In Business Settings → Users, select them, Add Assets → " +
            "Ad Accounts → this account → View Performance.";
        }
      }
      return { ok: false, rows: 0, error: message, hint };
    }
  } catch (err) {
    return { ok: false, rows: 0, error: err instanceof Error ? err.message : "Request failed" };
  }

  const rows = payload.data ?? [];
  if (!rows.length) return { ok: true, rows: 0 };

  // Whether the three client-facing action counts have anywhere to go. They
  // arrived after this table did, so a database that has not applied them
  // stores exactly what it always stored.
  const extra = await hasColumn("ad_insights", "profile_visits");
  const reachCol = await hasColumn("ad_insights", "reach_window");

  /*
   * Accounts reached over the window, from Meta rather than from arithmetic.
   *
   * The daily `reach` column cannot be added up: reach is people, and the same
   * person reached on Monday and Tuesday is one person. Nor can the per-ad
   * figures be added — two ads reaching overlapping audiences do not sum
   * either. Only Meta can deduplicate it, so this is one request for the
   * account over the whole window, stored against every row of that window
   * together with the number of days it covers.
   *
   * This is the number a client is shown as "Accounts reached". Relabelling
   * impressions would have been easier and would have overstated it — 103
   * impressions against 99 people, on a real account.
   */
  const accountWindowDays = Math.max(
    1,
    Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000) + 1
  );
  let accountReach: number | null = null;
  if (reachCol) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/${env.meta.apiVersion}/${account}/insights` +
          `?fields=reach&level=account` +
          `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
          `&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(30_000) }
      );
      const j = (await r.json()) as { data?: { reach?: string }[] };
      const v = j.data?.[0]?.reach;
      if (v !== undefined) accountReach = Math.trunc(Number(v) || 0);
    } catch {
      // The daily rows are the point of this sync; reach is the extra.
    }
  }

  const values: (string | number | null)[] = [];
  const placeholders: string[] = [];
  for (const r of rows) {
    if (!r.date_start) continue;
    // Counted rather than written out — a hand-typed row of question marks
    // that disagrees with the values pushed below fails at the database with a
    // message about neither.
    const cols = 8 + (extra ? 3 : 0) + (reachCol ? 2 : 0);
    placeholders.push(`(${Array(cols).fill("?").join(",")},NOW())`);
    values.push(
      clientId,
      r.date_start,
      Number(r.spend) || 0,
      (r.account_currency || "INR").slice(0, 8),
      Math.trunc(Number(r.impressions) || 0),
      Math.trunc(Number(r.reach) || 0),
      Math.trunc(Number(r.clicks) || 0),
      leadsFromActions(r.actions)
    );
    if (extra) {
      const got = reachedFromActions(r.actions);
      values.push(got.linkClicks, got.videoViews, got.profileVisits);
    }
    // The same window figure on every row of the window, with the window it
    // describes — so it can never be quoted for a period it does not cover.
    if (reachCol) values.push(accountReach, accountWindowDays);
  }
  if (!placeholders.length) return { ok: true, rows: 0 };

  /*
   * Upsert, because a day that has already been stored is not finished with.
   * Meta keeps restating conversions as attribution settles, so re-syncing the
   * last four weeks is the whole point — and the second pull has to overwrite
   * the first rather than collide with it.
   */
  await execute(
    `INSERT INTO ad_insights
       (client_id, date, spend, currency, impressions, reach, clicks, leads${
         extra ? ", link_clicks, video_views, profile_visits" : ""
       }${reachCol ? ", reach_window, reach_window_days" : ""}, synced_at)
     VALUES ${placeholders.join(",")}
     ON DUPLICATE KEY UPDATE
       spend = VALUES(spend), currency = VALUES(currency),
       impressions = VALUES(impressions), reach = VALUES(reach),
       clicks = VALUES(clicks), leads = VALUES(leads),${
         extra
           ? ` link_clicks = VALUES(link_clicks), video_views = VALUES(video_views),
       profile_visits = VALUES(profile_visits),`
           : ""
       }${
         reachCol
           ? " reach_window = VALUES(reach_window), reach_window_days = VALUES(reach_window_days),"
           : ""
       } synced_at = NOW()`,
    values
  );
  // And the same window again, this time ad by ad. Deliberately after the
  // account totals are stored and deliberately unable to fail the sync: the
  // board has read `ad_insights` since before this existed, and it must keep
  // working on a database that has never applied `ad_performance`.
  await syncAdLevel(clientId, account, token, since, until).catch(() => 0);

  return { ok: true, rows: placeholders.length };
}

/**
 * The same window, ad by ad.
 *
 * `ad_insights` has only ever held one row per client per day — the account's
 * total. That answers "what is this costing us" and cannot answer the question
 * anyone actually asks next: *which ad*. There is no way to work it out from a
 * total, so it is a second request to Meta at `level=ad` and a second table.
 *
 * Best-effort, and that is the design rather than laziness. This runs after the
 * account totals are committed, so a Marketing API that declines ad-level
 * access, a table that has not been applied, or a timeout all cost the extra
 * detail and none of the board. Returning 0 is a real answer here.
 */
async function syncAdLevel(
  clientId: number,
  account: string,
  token: string,
  since: string,
  until: string
): Promise<number> {
  if (!(await hasTable("ad_performance"))) return 0;

  const url =
    `https://graph.facebook.com/${env.meta.apiVersion}/${account}/insights` +
    `?fields=ad_id,ad_name,campaign_name,adset_id,spend,impressions,reach,clicks,account_currency,actions` +
    `&time_increment=1&level=ad` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const payload = (await res.json()) as {
    data?: (InsightRow & {
      ad_id?: string;
      ad_name?: string;
      campaign_name?: string;
      adset_id?: string;
    })[];
    error?: { message?: string };
  };
  if (!res.ok || payload.error) {
    // Said out loud rather than swallowed silently: the board still works, but
    // somebody looking for the per-ad table needs to know why it is empty.
    console.warn(
      `[ads] ad-level sync for client ${clientId}:`,
      payload.error?.message || `HTTP ${res.status}`
    );
    return 0;
  }

  const extra = await hasColumn("ad_performance", "profile_visits");
  const geoCol = await hasColumn("ad_performance", "locations");
  const richCol = await hasColumn("ad_performance", "reach_window");

  /*
   * Reach for the window and whether each ad is still delivering — neither of
   * which the daily rows can give. See `adWindowExtras`.
   */
  const windowDays = Math.max(
    1,
    Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000) + 1
  );
  const extras = richCol
    ? await adWindowExtras(account, token, since, until)
    : new Map<string, { reach: number | null; status: string | null }>();

  /*
   * Where each ad set is aimed, fetched once for the whole account rather than
   * once per ad. Targeting lives on the ad set, not on the ad, and an account
   * with forty ads usually has a handful of ad sets behind them.
   *
   * Best-effort inside a best-effort: this is the third request of a sync that
   * has already stored everything that matters, so a Marketing API that will
   * not hand over targeting costs one column and nothing else.
   */
  const geoByAdSet = geoCol ? await adSetLocations(account, token) : new Map<string, string>();

  const values: (string | number | null)[] = [];
  const placeholders: string[] = [];
  for (const r of payload.data ?? []) {
    if (!r.date_start || !r.ad_id) continue;
    /*
     * Counted rather than written out. Eleven always, three more when the
     * action columns exist, two more when the location ones do — and a
     * hand-typed row of question marks that disagrees with the values pushed
     * below fails at the database with a message about neither.
     */
    const cols = 11 + (extra ? 3 : 0) + (geoCol ? 2 : 0) + (richCol ? 4 : 0);
    placeholders.push(`(${Array(cols).fill("?").join(",")},NOW())`);
    values.push(
      clientId,
      String(r.ad_id),
      r.date_start,
      (r.ad_name || "").slice(0, 255),
      (r.campaign_name || "").slice(0, 255),
      Number(r.spend) || 0,
      (r.account_currency || "INR").slice(0, 8),
      Math.trunc(Number(r.impressions) || 0),
      Math.trunc(Number(r.reach) || 0),
      Math.trunc(Number(r.clicks) || 0),
      leadsFromActions(r.actions)
    );
    if (extra) {
      const got = reachedFromActions(r.actions);
      values.push(got.linkClicks, got.videoViews, got.profileVisits);
    }
    if (geoCol) {
      const adset = r.adset_id ? String(r.adset_id) : "";
      values.push(adset || null, geoByAdSet.get(adset) ?? null);
    }
    if (richCol) {
      const got = extras.get(String(r.ad_id));
      values.push(
        reachedFromActions(r.actions).engagement,
        got?.status ?? null,
        got?.reach ?? null,
        // Stored with the window it describes, so it is never shown against a
        // range it does not cover.
        windowDays
      );
    }
  }
  if (!placeholders.length) return 0;

  await execute(
    `INSERT INTO ad_performance
       (client_id, ad_id, date, ad_name, campaign_name, spend, currency,
        impressions, reach, clicks, leads${
          extra ? ", link_clicks, video_views, profile_visits" : ""
        }${geoCol ? ", adset_id, locations" : ""}${
          richCol ? ", engagement, ad_status, reach_window, reach_window_days" : ""
        }, synced_at)
     VALUES ${placeholders.join(",")}
     ON DUPLICATE KEY UPDATE
       ad_name = VALUES(ad_name), campaign_name = VALUES(campaign_name),
       spend = VALUES(spend), currency = VALUES(currency),
       impressions = VALUES(impressions), reach = VALUES(reach),
       clicks = VALUES(clicks), leads = VALUES(leads),${
         extra
           ? ` link_clicks = VALUES(link_clicks), video_views = VALUES(video_views),
       profile_visits = VALUES(profile_visits),`
           : ""
       }${
         geoCol ? " adset_id = VALUES(adset_id), locations = VALUES(locations)," : ""
       }${
         richCol
           ? ` engagement = VALUES(engagement), ad_status = VALUES(ad_status),
       reach_window = VALUES(reach_window), reach_window_days = VALUES(reach_window_days),`
           : ""
       } synced_at = NOW()`,
    values
  );
  return placeholders.length;
}

/**
 * Where each ad set on this account is aimed.
 *
 * One request for the whole account: targeting lives on the ad set, and forty
 * ads usually sit behind a handful of them. Asking per ad would be forty
 * requests to answer one question.
 *
 * Returns an empty map on any failure. Location is the nicest thing on the
 * row and the least important — an ad with no location beside it is still an
 * ad, and a sync that failed over one would be a bad trade.
 */
async function adSetLocations(account: string, token: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const url =
      `https://graph.facebook.com/${env.meta.apiVersion}/${account}/adsets` +
      `?fields=id,targeting{geo_locations}&limit=500&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as {
      data?: { id?: string; targeting?: { geo_locations?: GeoSpec } }[];
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      console.warn("[ads] ad set targeting:", json.error?.message || `HTTP ${res.status}`);
      return out;
    }
    for (const a of json.data ?? []) {
      const where = describeGeo(a.targeting?.geo_locations);
      if (a.id && where) out.set(String(a.id), where.slice(0, 500));
    }
  } catch {
    // Same reason as above: this is the third request of a sync that has
    // already stored everything that matters.
  }
  return out;
}

/** Every client with an ad account, synced one at a time. */
export async function syncAllAds(days = RESTATEMENT_DAYS): Promise<{
  synced: number;
  rows: number;
  failures: { client: string; error: string; hint?: string }[];
}> {
  const { ready } = await adsReadiness();
  if (!ready) return { synced: 0, rows: 0, failures: [] };

  const clients = await query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM clients
      WHERE status <> 'churned'
        AND meta_ad_account_id IS NOT NULL AND meta_ad_account_id <> ''
      ORDER BY company_name`
  );

  let synced = 0;
  let rows = 0;
  const failures: { client: string; error: string; hint?: string }[] = [];
  for (const c of clients) {
    const r = await syncClientAds(c.id, days);
    if (r.ok) {
      synced++;
      rows += r.rows;
    } else {
      failures.push({ client: c.company_name, error: r.error || "Unknown error", hint: r.hint });
    }
  }
  return { synced, rows, failures };
}

/* ------------------------------ Reading it back ----------------------------- */

export type AdRow = {
  clientId: number;
  company: string;
  /** Null when this client has no ad account connected at all. */
  accountId: string | null;
  currency: string;
  spend: number;
  impressions: number;
  /**
   * Accounts reached — people, deduplicated by Meta over a window.
   *
   * Null when the range on screen is not the range that figure covers. This
   * used to be a SUM of the daily column, which counts the same person once
   * per day they were reached: a number that grew with the length of the range
   * and looked exactly like the ones beside it.
   */
  reach: number | null;
  clicks: number;
  leads: number;
  /** Null when there were no leads — not zero, which would read as free. */
  costPerLead: number | null;
  /** Cost per thousand impressions. Null with no impressions. */
  cpm: number | null;
  /** Click-through rate as a percentage. Null with no impressions. */
  ctr: number | null;
  /** The most recent day Meta has given us for this client. */
  lastSynced: string | null;
};

export type AdSummary = {
  from: string;
  to: string;
  rows: AdRow[];
  totals: {
    /** Per currency, because adding INR to USD would be a lie. */
    spendByCurrency: { currency: string; spend: number }[];
    impressions: number;
    clicks: number;
    leads: number;
    /** Only when every client in range shares one currency. */
    costPerLead: number | null;
    currency: string | null;
  };
  /** Clients with an ad account but no data in this range. */
  connectedButQuiet: string[];
  /** Clients with no ad account at all — shown so their absence is explained. */
  notConnected: string[];
};

const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/**
 * The dashboard's numbers for a date range.
 *
 * Both ends inclusive, and both are dates rather than timestamps: an ad day is
 * Meta's day in the account's timezone, not a moment in ours.
 */
export async function adSummary(from: string, to: string): Promise<AdSummary> {
  const { ready } = await adsReadiness();

  /*
   * How many days the caller is asking about. Reach is only shown when that
   * matches the window Meta deduplicated it over — see AdRow.reach.
   */
  const askedDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const empty: AdSummary = {
    from,
    to,
    rows: [],
    totals: {
      spendByCurrency: [],
      impressions: 0,
      clicks: 0,
      leads: 0,
      costPerLead: null,
      currency: null,
    },
    connectedButQuiet: [],
    notConnected: [],
  };
  if (!ready) return empty;

  const clients = await query<{ id: number; company_name: string; meta_ad_account_id: string | null }>(
    `SELECT id, company_name, meta_ad_account_id FROM clients
      WHERE status <> 'churned' ORDER BY company_name`
  );

  /*
   * Grouped by currency as well as by client.
   *
   * An account whose currency changed mid-range has days in both, and folding
   * them into one row means adding the two together and labelling the result
   * with whichever sorted first — a wrong number that looks entirely normal.
   * Two rows for that client is the honest shape, and the common case of one
   * currency is unaffected.
   */
  const agg = await query<{
    client_id: number;
    currency: string;
    spend: string;
    impressions: string;
    reach: string | null;
    reach_days: number | null;
    clicks: string;
    leads: string;
    last_day: string;
  }>(
    `SELECT client_id, currency,
            SUM(spend)             AS spend,
            SUM(impressions)       AS impressions,
            /* Reach is people, and a SUM of a daily figure is not. This summed
               the daily column for a long time, which counts the same person
               once for every day they were reached — a number that grows with
               the length of the range and looks exactly like the others. Meta
               deduplicates it for a window; that figure is stored with the
               window it covers, and read here rather than added up. */
            MAX(reach_window)      AS reach,
            MAX(reach_window_days) AS reach_days,
            SUM(clicks)            AS clicks,
            SUM(leads)             AS leads,
            MAX(date)              AS last_day
       FROM ad_insights
      WHERE date BETWEEN ? AND ?
      GROUP BY client_id, currency`,
    [from, to]
  ).catch(async () =>
    /*
     * A database that has not applied `reach_window` yet. Rather than fail the
     * whole board for one column, ask again without it — the row then carries
     * no reach at all, which renders as a dash.
     */
    query<{
      client_id: number;
      currency: string;
      spend: string;
      impressions: string;
      reach: string | null;
      reach_days: number | null;
      clicks: string;
      leads: string;
      last_day: string;
    }>(
      `SELECT client_id, currency,
              SUM(spend) AS spend, SUM(impressions) AS impressions,
              NULL AS reach, NULL AS reach_days,
              SUM(clicks) AS clicks, SUM(leads) AS leads, MAX(date) AS last_day
         FROM ad_insights
        WHERE date BETWEEN ? AND ?
        GROUP BY client_id, currency`,
      [from, to]
    )
  );
  const byClient = new Map<number, typeof agg>();
  for (const a of agg) {
    const id = Number(a.client_id);
    byClient.set(id, [...(byClient.get(id) ?? []), a]);
  }

  const rows: AdRow[] = [];
  const connectedButQuiet: string[] = [];
  const notConnected: string[] = [];

  for (const c of clients) {
    const account = normaliseAccountId(c.meta_ad_account_id);
    const found = byClient.get(c.id);

    if (!found?.length) {
      if (account) connectedButQuiet.push(c.company_name);
      else notConnected.push(c.company_name);
      continue;
    }

    for (const a of found) {
      const spend = Number(a.spend) || 0;
      const impressions = Number(a.impressions) || 0;
      const clicks = Number(a.clicks) || 0;
      const leads = Number(a.leads) || 0;

      rows.push({
        clientId: c.id,
        company: c.company_name,
        accountId: account,
        currency: a.currency || "INR",
        spend,
        impressions,
        reach:
          a.reach !== null && Number(a.reach_days) === askedDays
            ? Number(a.reach) || 0
            : null,
        clicks,
        leads,
        costPerLead: div(spend, leads),
        cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
        lastSynced: a.last_day ? String(a.last_day).slice(0, 10) : null,
      });
    }
  }

  // Biggest spender first — the money is what this board is opened for.
  rows.sort((x, y) => y.spend - x.spend);

  const spendByCurrency = [...
    rows.reduce((m, r) => m.set(r.currency, (m.get(r.currency) ?? 0) + r.spend), new Map<string, number>())
  ].map(([currency, spend]) => ({ currency, spend }));

  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const leads = rows.reduce((s, r) => s + r.leads, 0);

  /*
   * One overall cost per lead only when there is one currency to express it
   * in. With two, there is no single true answer and the per-client column is
   * the honest place to read it.
   */
  const single = spendByCurrency.length === 1 ? spendByCurrency[0] : null;

  return {
    from,
    to,
    rows,
    totals: {
      spendByCurrency,
      impressions,
      clicks,
      leads,
      costPerLead: single ? div(single.spend, leads) : null,
      currency: single?.currency ?? null,
    },
    connectedButQuiet,
    notConnected,
  };
}

/* ----------------------------- One client, in full --------------------------- */

export type ClientAdDetail = {
  client: {
    id: number;
    company: string;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    accountId: string | null;
    monthlyPackage: string | null;
    packageAmount: number;
    status: string;
  };
  from: string;
  to: string;
  /** Every day in range that has data, newest first. */
  days: {
    date: string;
    spend: number;
    currency: string;
    impressions: number;
    reach: number;
    clicks: number;
    leads: number;
    costPerLead: number | null;
    ctr: number | null;
  }[];
  /** The same arithmetic as the board, for this client alone. */
  totals: {
    currency: string;
    spend: number;
    impressions: number;
    reach: number;
    clicks: number;
    leads: number;
    costPerLead: number | null;
    cpm: number | null;
    ctr: number | null;
    /** Days with any spend — the denominator for "per day" without lying. */
    activeDays: number;
  } | null;
  /** The cheapest and dearest lead in range, when there is more than one day. */
  best: { date: string; costPerLead: number } | null;
  worst: { date: string; costPerLead: number } | null;
};

/**
 * One client's ad record, day by day.
 *
 * The board answers "what is this costing us across the book"; this answers
 * "what happened on this account", which is the question asked the moment a
 * client rings up about their own numbers. Their contact details come with it
 * for the same reason — the person looking at a cost per lead is usually about
 * to talk to somebody about it.
 *
 * Reads the stored daily rows rather than calling Meta: the sync already
 * fetched them, and a page that hits the Graph API on every load is a page
 * that is slow when it matters and broken when the token lapses.
 */
export async function clientAdDetail(
  clientId: number,
  from: string,
  to: string
): Promise<ClientAdDetail | null> {
  const c = await queryOne<{
    id: number;
    company_name: string;
    contact_person: string | null;
    email: string | null;
    phone: string | null;
    meta_ad_account_id: string | null;
    monthly_package: string | null;
    package_amount: string | null;
    status: string;
  }>(
    `SELECT id, company_name, contact_person, email, phone, meta_ad_account_id,
            monthly_package, package_amount, status
       FROM clients WHERE id = ?`,
    [clientId]
  );
  if (!c) return null;

  const client = {
    id: c.id,
    company: c.company_name,
    contactPerson: c.contact_person,
    email: c.email,
    phone: c.phone,
    accountId: normaliseAccountId(c.meta_ad_account_id),
    monthlyPackage: c.monthly_package,
    packageAmount: Number(c.package_amount) || 0,
    status: c.status,
  };

  const { ready } = await adsReadiness();
  if (!ready) return { client, from, to, days: [], totals: null, best: null, worst: null };

  const rows = await query<{
    date: string;
    spend: string;
    currency: string;
    impressions: string;
    reach: string;
    clicks: string;
    leads: string;
  }>(
    `SELECT date, spend, currency, impressions, reach, clicks, leads
       FROM ad_insights
      WHERE client_id = ? AND date BETWEEN ? AND ?
      ORDER BY date DESC`,
    [clientId, from, to]
  );

  const days = rows.map((r) => {
    const spend = Number(r.spend) || 0;
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    const leads = Number(r.leads) || 0;
    return {
      date: String(r.date).slice(0, 10),
      spend,
      currency: r.currency || "INR",
      impressions,
      reach: Number(r.reach) || 0,
      clicks,
      leads,
      costPerLead: div(spend, leads),
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    };
  });

  if (!days.length) return { client, from, to, days, totals: null, best: null, worst: null };

  const sum = (pick: (d: (typeof days)[number]) => number) => days.reduce((s, d) => s + pick(d), 0);
  const spend = sum((d) => d.spend);
  const impressions = sum((d) => d.impressions);
  const clicks = sum((d) => d.clicks);
  const leads = sum((d) => d.leads);

  /*
   * The best and worst day, by cost per lead.
   *
   * Only days that actually produced a lead are eligible. A day that spent
   * nothing has no cost per lead at all, and a day that spent money for no
   * leads is the worst kind — but it has no number to rank, and calling it
   * "₹0" would put it top of a "cheapest" list.
   */
  const ranked = days
    .filter((d) => d.costPerLead !== null)
    .sort((a, b) => (a.costPerLead as number) - (b.costPerLead as number));

  return {
    client,
    from,
    to,
    days,
    totals: {
      // One account reports one currency; the first day's is the account's.
      currency: days[0].currency,
      spend,
      impressions,
      reach: sum((d) => d.reach),
      clicks,
      leads,
      costPerLead: div(spend, leads),
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      activeDays: days.filter((d) => d.spend > 0).length,
    },
    best: ranked.length > 1 ? { date: ranked[0].date, costPerLead: ranked[0].costPerLead! } : null,
    worst:
      ranked.length > 1
        ? {
            date: ranked[ranked.length - 1].date,
            costPerLead: ranked[ranked.length - 1].costPerLead!,
          }
        : null,
  };
}

/** When the numbers were last refreshed from Meta, for the "as of" line. */
export async function lastAdSync(clientId?: number): Promise<string | null> {
  if (!(await hasTable("ad_insights"))) return null;
  /*
   * For one client when asked about one.
   *
   * The board's "last refreshed" is the newest row anywhere, which is right
   * for the board and wrong on a client's own page: a nightly run that
   * succeeded for nine clients and failed on the tenth would tell the tenth's
   * page that its numbers are minutes old. The one number a person reads
   * before ringing a client about their spend should be about that client.
   */
  const r = clientId
    ? await queryOne<{ at: string | null }>(
        "SELECT MAX(synced_at) AS at FROM ad_insights WHERE client_id = ?",
        [clientId]
      )
    : await queryOne<{ at: string | null }>("SELECT MAX(synced_at) AS at FROM ad_insights");
  return r?.at ? String(r.at) : null;
}

/* ---------------------------- Ad by ad ---------------------------- */

export type AdPerf = {
  adId: string;
  clientId: number;
  client: string;
  name: string;
  campaign: string | null;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  /** Null when there were no leads — not zero, which would read as free. */
  costPerLead: number | null;
  ctr: number | null;
  cpm: number | null;
  /** Days this ad actually spent anything, which is how long it really ran. */
  days: number;
  lastDay: string;
  /**
   * Where it was aimed, in words.
   *
   * Null until the ad-level sync has read the ad set's targeting, and null
   * renders as a dash rather than as "everywhere" — the two are very different
   * claims and only one of them is ever true by default.
   */
  locations: string | null;
  /** Still delivering, or paused. Meta's own word for it. */
  status: string | null;
  /** Reactions, comments, shares, saves, taps. Null where Meta never said. */
  engagement: number | null;
  videoViews: number | null;
  /**
   * People reached — deduplicated by Meta for the window it synced, never a
   * sum of daily figures.
   *
   * Null when the range on screen is not the range the figure covers. A reach
   * number quoted against the wrong period is worse than none: it looks
   * precise, it is roughly right, and nobody can tell which.
   */
  reach: number | null;
};

/*
 * Reach is not here on purpose.
 *
 * Every other figure on this row is additive across days; reach is people, and
 * the same person reached on Monday and Tuesday is one person. Adding daily
 * reach would produce a bigger, wronger number that looks like the others, and
 * there is no way to recover the true figure from stored daily rows. A missing
 * column is honest; a double-counted one is not. Impressions answer the
 * question people are usually asking anyway.
 */

/**
 * How many impressions an ad needs before its click rate means anything.
 *
 * Two clicks out of eleven impressions is an 18% CTR and tells you nothing.
 * Comparing that against a properly delivered ad would name the wrong winner
 * with total confidence, which is worse than declining to name one.
 *
 * ponytail: a flat floor, not a significance test. If ad budgets get large
 * enough that near-misses matter, a proper interval belongs here.
 */
export const CTR_FLOOR = 200;

export type AdRanking = {
  /** What the ads were judged on, or null when nothing could be judged. */
  by: "costPerLead" | "ctr" | null;
  best: string | null;
  worst: string | null;
  /** Why there is no verdict, when there isn't one. Shown, not swallowed. */
  reason?: string;
};

/**
 * Which of these ads is working, and which is not.
 *
 * Two measures, and which one applies is decided by the data rather than by a
 * preference. If any ad produced leads, cost per lead settles it — that is what
 * the money was for. If none did, the ads have not been given a chance to prove
 * anything on leads and click rate is the only honest signal left; it is a
 * weaker one, so it is named as such rather than dressed up.
 *
 * Refuses to answer rather than guessing. One qualifying ad is not a
 * comparison, and an ad below the impressions floor has a click rate made of
 * noise. Both cases return a reason, which is a more useful thing to put on a
 * screen than an arbitrary winner.
 *
 * Pure, and exported, because this is the one judgement on the page that a
 * person will act on — pausing an ad costs real money.
 */
export function rankAds(rows: AdPerf[]): AdRanking {
  const withLeads = rows.filter((r) => r.leads > 0 && r.costPerLead !== null);
  if (withLeads.length >= 2) {
    const sorted = [...withLeads].sort((a, b) => a.costPerLead! - b.costPerLead!);
    return { by: "costPerLead", best: sorted[0].adId, worst: sorted[sorted.length - 1].adId };
  }
  if (withLeads.length === 1 && rows.length > 1) {
    // One ad has leads and the others have none. That is a comparison, and the
    // answer is obvious enough not to need a ranking to state it.
    return {
      by: "costPerLead",
      best: withLeads[0].adId,
      worst: null,
      reason: "Only one ad has produced leads, so there is nothing to rank it against.",
    };
  }

  const deliverable = rows.filter((r) => r.impressions >= CTR_FLOOR && r.ctr !== null);
  if (deliverable.length >= 2) {
    const sorted = [...deliverable].sort((a, b) => b.ctr! - a.ctr!);
    return { by: "ctr", best: sorted[0].adId, worst: sorted[sorted.length - 1].adId };
  }

  return {
    by: null,
    best: null,
    worst: null,
    reason: rows.length
      ? `No ad has leads yet, and none has passed ${CTR_FLOOR} impressions — too early to call.`
      : "No ad data in this range.",
  };
}

/**
 * Every ad that spent or was shown in a date range, biggest spender first.
 *
 * Reads the stored rows, like everything else on this board. The sync fills
 * them; this never calls Meta.
 */
export async function adPerformance(
  from: string,
  to: string,
  clientId?: number
): Promise<AdPerf[]> {
  if (!(await hasTable("ad_performance"))) return [];
  const geoCol = await hasColumn("ad_performance", "locations");
  const richCol = await hasColumn("ad_performance", "reach_window");

  /*
   * How many days the caller is asking about. Reach is only shown when that
   * matches the window Meta deduplicated it over — see `AdPerf.reach`.
   */
  const askedDays = Math.max(
    1,
    Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  );

  const params: (string | number)[] = [from, to];
  if (clientId) params.push(clientId);

  const rows = await query<{
    ad_id: string;
    client_id: number;
    company_name: string;
    ad_name: string | null;
    campaign_name: string | null;
    currency: string;
    spend: string;
    impressions: string;
    clicks: string;
    leads: string;
    days: number;
    last_day: string;
    locations: string | null;
    engagement: string | null;
    video_views: string | null;
    ad_status: string | null;
    reach_window: string | null;
    reach_window_days: number | null;
  }>(
    `SELECT p.ad_id, p.client_id, c.company_name,
            /* The latest name Meta gave it — ads get renamed mid-flight, and
               the old name on screen is how somebody pauses the wrong one.
               A subquery rather than a GROUP_CONCAT trick: MAX() would pick
               the alphabetically last name, which is not the same as the
               latest one. */
            (SELECT n.ad_name FROM ad_performance n
              WHERE n.ad_id = p.ad_id ORDER BY n.date DESC LIMIT 1) AS ad_name,
            (SELECT n.campaign_name FROM ad_performance n
              WHERE n.ad_id = p.ad_id ORDER BY n.date DESC LIMIT 1) AS campaign_name,
            MAX(p.currency) AS currency,
            SUM(p.spend) AS spend,
            SUM(p.impressions) AS impressions,
            SUM(p.clicks) AS clicks,
            SUM(p.leads) AS leads,
            SUM(p.spend > 0) AS days,
            MAX(p.date) AS last_day,
            /* The latest targeting we saw — same reasoning as the name. An ad
               set can be re-aimed mid-flight, and yesterday's answer on screen
               is worse than no answer. */
            ${
              geoCol
                ? `(SELECT n.locations FROM ad_performance n
                     WHERE n.ad_id = p.ad_id AND n.locations IS NOT NULL
                     ORDER BY n.date DESC LIMIT 1)`
                : "NULL"
            } AS locations,
            ${richCol ? "SUM(p.engagement) AS engagement" : "NULL AS engagement"},
            ${richCol ? "SUM(p.video_views) AS video_views" : "NULL AS video_views"},
            /* The newest of each — a status and a window reach describe the ad
               now, not one day of it, so they are read rather than added. */
            ${
              richCol
                ? `(SELECT n.ad_status FROM ad_performance n
                     WHERE n.ad_id = p.ad_id AND n.ad_status IS NOT NULL
                     ORDER BY n.date DESC LIMIT 1)`
                : "NULL"
            } AS ad_status,
            ${
              richCol
                ? `(SELECT n.reach_window FROM ad_performance n
                     WHERE n.ad_id = p.ad_id AND n.reach_window IS NOT NULL
                     ORDER BY n.date DESC LIMIT 1)`
                : "NULL"
            } AS reach_window,
            ${
              richCol
                ? `(SELECT n.reach_window_days FROM ad_performance n
                     WHERE n.ad_id = p.ad_id AND n.reach_window IS NOT NULL
                     ORDER BY n.date DESC LIMIT 1)`
                : "NULL"
            } AS reach_window_days
       FROM ad_performance p
       JOIN clients c ON c.id = p.client_id
      WHERE p.date BETWEEN ? AND ?
        ${clientId ? "AND p.client_id = ?" : ""}
      GROUP BY p.ad_id, p.client_id, c.company_name
      /* Anything with no spend and no impressions is an ad that did not run in
         this range at all — Meta returns the row, it just has nothing in it. */
     HAVING spend > 0 OR impressions > 0
      ORDER BY spend DESC, impressions DESC`,
    params
  ).catch(() => []);

  return rows.map((r) => {
    const spend = Number(r.spend) || 0;
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    const leads = Number(r.leads) || 0;
    return {
      adId: r.ad_id,
      clientId: r.client_id,
      client: r.company_name,
      // Meta always names an ad, but a blank one must not render as an empty
      // row somebody cannot click on.
      name: (r.ad_name || "").trim() || `Ad ${r.ad_id}`,
      campaign: (r.campaign_name || "").trim() || null,
      currency: r.currency || "INR",
      spend,
      impressions,
      clicks,
      leads,
      costPerLead: div(spend, leads),
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpm: div(spend, impressions / 1000),
      days: Number(r.days) || 0,
      lastDay: String(r.last_day).slice(0, 10),
      locations: (r.locations || "").trim() || null,
      status: (r.ad_status || "").trim() || null,
      engagement: r.engagement === null ? null : Number(r.engagement) || 0,
      videoViews: r.video_views === null ? null : Number(r.video_views) || 0,
      /*
       * Only when the window matches. Meta deduplicated this over a specific
       * number of days; quoted against a different range it looks precise, is
       * roughly right, and nobody can tell which — the worst kind of number.
       */
      reach:
        r.reach_window !== null && Number(r.reach_window_days) === askedDays
          ? Number(r.reach_window) || 0
          : null,
    };
  });
}

/* ------------------------- What the client is shown ------------------------- */

export type ClientAdView = {
  adId: string;
  name: string;
  campaign: string | null;
  /** Times the ad was put in front of somebody. */
  impressions: number;
  clicks: number;
  ctr: number | null;
  /** Null where Meta never reported the action — not zero, which reads as "nobody did". */
  videoViews: number | null;
  profileVisits: number | null;
  /**
   * Reactions, comments, shares, saves, taps — people doing something with the
   * post rather than only seeing it. Null where Meta never reported it.
   */
  engagement: number | null;
  leads: number;
  days: number;
  /**
   * Where it was aimed. The question a client asks first — and a dash until
   * the targeting has been read, never "everywhere".
   */
  locations: string | null;
};

export type ClientAdsSummary = {
  from: string;
  to: string;
  /**
   * The client's own name.
   *
   * Only so it can be stripped off the front of their ad names. On the
   * client's own page "Freskos - Video Ad 5 - Order Now" spends half the
   * column saying who they are, to them.
   */
  company: string;
  ads: ClientAdView[];
  totals: {
    ads: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
    videoViews: number | null;
    profileVisits: number | null;
    engagement: number | null;
    leads: number;
    /**
     * Accounts reached — people, deduplicated by Meta.
     *
     * Null when we have no figure for a window that fits. Reach is the one
     * number here that cannot be worked out from anything else we store, so
     * "we do not have it" is a real answer and impressions are not a stand-in
     * for it: on a real account 103 impressions were 99 people.
     */
    reach: number | null;
    /** How many days that reach figure covers, so the screen can say. */
    reachDays: number | null;
  };
  /** The last day Meta has given us anything for. */
  lastDay: string | null;
};

/**
 * One client's own ad results, with no money in them anywhere.
 *
 * What a client is owed is the outcome: how many people saw it, how many
 * clicked, how many watched, how many went and looked at the profile, how many
 * got in touch. What the agency paid Meta is the agency's business — it is a
 * negotiated rate, it varies between clients, and it is the single fastest way
 * to turn a results conversation into a pricing argument.
 *
 * So spend is absent from the SELECT, not hidden in the template. A column
 * that is fetched and then not rendered is one careless \`{...row}\` away from
 * being on a client's screen, and the diff that does it looks harmless. The
 * only way to be sure is for the number never to leave the database.
 *
 * For the same reason there is no cost per lead here, and no CPM: both are
 * spend wearing a different hat, and either one plus a lead count gives the
 * spend back by arithmetic.
 */
export async function clientAdsSummary(
  clientId: number,
  from: string,
  to: string
): Promise<ClientAdsSummary> {
  const empty: ClientAdsSummary = {
    from,
    to,
    company: "",
    ads: [],
    totals: {
      ads: 0,
      impressions: 0,
      clicks: 0,
      ctr: null,
      videoViews: null,
      profileVisits: null,
      engagement: null,
      leads: 0,
      reach: null,
      reachDays: null,
    },
    lastDay: null,
  };
  if (!clientId || !(await hasTable("ad_performance"))) return empty;

  // The three action counts arrived after the table did. On a database that
  // has not applied them the page still works and simply shows dashes, which
  // is the truth: we do not have those figures.
  const extra = await hasColumn("ad_performance", "profile_visits");
  // Targeting arrived later still, and on its own — an install may have one
  // and not the other.
  const extraGeo = await hasColumn("ad_performance", "locations");
  // Engagement arrived later still, and on its own.
  const engagementCol = await hasColumn("ad_performance", "engagement").catch(() => false);

  /*
   * Accounts reached, taken from the account-level figure rather than added up.
   *
   * Reach is people. The same person reached on two days is one person, and
   * two ads reaching overlapping audiences do not sum either — so neither the
   * daily column nor the per-ad ones can produce this. Meta deduplicates it
   * for a window and that is the only number worth quoting.
   *
   * Read from any row inside the range: the sync writes the same window figure
   * on every row of the window it covers.
   */
  const company = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [clientId]
  ).catch(() => null);

  const reached = (await hasColumn("ad_insights", "reach_window").catch(() => false))
    ? await queryOne<{ reach_window: number | null; reach_window_days: number | null }>(
        `SELECT reach_window, reach_window_days
           FROM ad_insights
          WHERE client_id = ? AND date BETWEEN ? AND ? AND reach_window IS NOT NULL
          ORDER BY date DESC LIMIT 1`,
        [clientId, from, to]
      ).catch(() => null)
    : null;

  const rows = await query<{
    ad_id: string;
    ad_name: string | null;
    campaign_name: string | null;
    impressions: string;
    clicks: string;
    leads: string;
    video_views: string | null;
    profile_visits: string | null;
    engagement: string | null;
    days: number;
    last_day: string;
    locations: string | null;
  }>(
    `SELECT p.ad_id,
            (SELECT n.ad_name FROM ad_performance n
              WHERE n.ad_id = p.ad_id ORDER BY n.date DESC LIMIT 1) AS ad_name,
            (SELECT n.campaign_name FROM ad_performance n
              WHERE n.ad_id = p.ad_id ORDER BY n.date DESC LIMIT 1) AS campaign_name,
            SUM(p.impressions) AS impressions,
            SUM(p.clicks) AS clicks,
            SUM(p.leads) AS leads,
            ${extra ? "SUM(p.video_views) AS video_views," : "NULL AS video_views,"}
            ${extra ? "SUM(p.profile_visits) AS profile_visits," : "NULL AS profile_visits,"}
            ${engagementCol ? "SUM(p.engagement) AS engagement," : "NULL AS engagement,"}
            COUNT(*) AS days,
            MAX(p.date) AS last_day,
            /* Where it ran. The question a client asks first, and the one
               thing on this page that is not a number. */
            ${
              extraGeo
                ? `(SELECT n.locations FROM ad_performance n
                     WHERE n.ad_id = p.ad_id AND n.locations IS NOT NULL
                     ORDER BY n.date DESC LIMIT 1)`
                : "NULL"
            } AS locations
       FROM ad_performance p
      WHERE p.client_id = ? AND p.date BETWEEN ? AND ?
      GROUP BY p.ad_id
     HAVING impressions > 0
      ORDER BY impressions DESC`,
    [clientId, from, to]
  ).catch(() => []);

  if (!rows.length) return empty;

  /*
   * A summed NULL is NULL in MySQL, and that is the behaviour wanted: an
   * account where Meta never reported profile visits totals to nothing, and
   * nothing renders as a dash. Summing it as zero would print a confident "0
   * profile visits" to a client about an ad that may well have driven plenty.
   */
  const n = (v: string | number | null): number | null =>
    v === null || v === undefined ? null : Number(v) || 0;

  const ads: ClientAdView[] = rows.map((r) => {
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    return {
      adId: r.ad_id,
      name: (r.ad_name || "").trim() || "Ad",
      campaign: (r.campaign_name || "").trim() || null,
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      videoViews: n(r.video_views),
      profileVisits: n(r.profile_visits),
      engagement: n(r.engagement),
      leads: Number(r.leads) || 0,
      days: Number(r.days) || 0,
      locations: (r.locations || "").trim() || null,
    };
  });

  const sumOrNull = (pick: (a: ClientAdView) => number | null): number | null => {
    const got = ads.map(pick).filter((v): v is number => v !== null);
    return got.length ? got.reduce((a, b) => a + b, 0) : null;
  };

  const impressions = ads.reduce((t, a) => t + a.impressions, 0);
  const clicks = ads.reduce((t, a) => t + a.clicks, 0);

  return {
    from,
    to,
    company: company?.company_name ?? "",
    ads,
    totals: {
      ads: ads.length,
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      videoViews: sumOrNull((a) => a.videoViews),
      profileVisits: sumOrNull((a) => a.profileVisits),
      engagement: sumOrNull((a) => a.engagement),
      leads: ads.reduce((t, a) => t + a.leads, 0),
      /*
       * The figure we have, with the period it covers — not withheld because
       * the picker says something slightly different.
       *
       * Meta deduplicates reach over the window the sync asked for, which is
       * 28 days; the page defaults to a calendar month. Those never match
       * exactly, so requiring them to would leave the headline card as a dash
       * for ever — a real number, thrown away over three days.
       *
       * So it is shown and the period is stated beside it. That is honest and
       * useful, where a permanent dash was neither.
       */
      reach:
        reached && reached.reach_window !== null ? Number(reached.reach_window) || 0 : null,
      reachDays: reached ? Number(reached.reach_window_days) || null : null,
    },
    lastDay: rows.map((r) => String(r.last_day).slice(0, 10)).sort().pop() ?? null,
  };
}

/* ------------------------------ Where it ran ------------------------------ */

/**
 * Meta's `geo_locations` spec, as far as this needs to read it.
 *
 * Every field is optional and an ad set may carry several at once — a
 * campaign aimed at two cities and a whole state is one object with `cities`
 * and `regions` both filled in.
 */
export type GeoSpec = {
  countries?: string[];
  country_groups?: string[];
  regions?: { key?: string; name?: string }[];
  cities?: { key?: string; name?: string; region?: string; country?: string }[];
  zips?: { key?: string; name?: string }[];
  places?: { key?: string; name?: string }[];
  custom_locations?: { name?: string; latitude?: number; longitude?: number; radius?: number }[];
  location_types?: string[];
};

/** Two-letter codes are not an answer to "where are we running this". */
const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  AE: "UAE",
  AU: "Australia",
  CA: "Canada",
  SG: "Singapore",
  MY: "Malaysia",
  NZ: "New Zealand",
  ZA: "South Africa",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  NL: "Netherlands",
  IE: "Ireland",
  SA: "Saudi Arabia",
  QA: "Qatar",
  KW: "Kuwait",
  OM: "Oman",
  BH: "Bahrain",
  LK: "Sri Lanka",
  NP: "Nepal",
  BD: "Bangladesh",
  PK: "Pakistan",
};

export const countryName = (code: string): string =>
  COUNTRY_NAMES[String(code).toUpperCase()] ?? String(code).toUpperCase();

/**
 * Where an ad set is aimed, in words.
 *
 * Asked for directly, and it is the one thing about an ad that neither the
 * spend nor the click rate can tell you: two ads with identical numbers are
 * completely different pieces of work if one ran in Hyderabad and the other
 * across India. It is also the question a client asks first.
 *
 * The rule is smallest-first, because that is the useful end. An ad set aimed
 * at two cities inside India is "Hyderabad, Bengaluru" — saying "India" would
 * be true and useless. The country only appears on its own when nothing
 * narrower was set.
 *
 * Pure, and exported, so the shape of Meta's spec can be held here rather than
 * discovered in production.
 */
export function describeGeo(geo: GeoSpec | null | undefined, max = 4): string | null {
  if (!geo || typeof geo !== "object") return null;

  /*
   * Meta hands these back as objects keyed by position, not as arrays.
   *
   * A real ad set comes over the wire as
   * `custom_locations: { "0": { name: …, radius: 12 } }`, and `.map` on that is
   * not a function. Written against the documented array shape this threw on
   * every account that had any targeting at all — and the throw was swallowed
   * by the caller's catch, so the column simply stayed empty and looked like a
   * feature that had not been wired up.
   *
   * Both shapes are accepted rather than picking one: Meta returns arrays in
   * some places and numbered objects in others, and there is no version of
   * this worth being strict about.
   */
  const asArray = <T,>(v: unknown): T[] => {
    if (Array.isArray(v)) return v as T[];
    if (v && typeof v === "object") return Object.values(v as Record<string, T>);
    return [];
  };

  const named = (xs: unknown): string[] =>
    asArray<{ name?: string; key?: string }>(xs)
      .map((x) => (x?.name || x?.key || "").trim())
      .filter(Boolean);

  // Smallest first: a radius round a point, then a place, then a city, then a
  // region. Whichever level is present and narrowest is the honest answer.
  const custom = asArray<{
    name?: string;
    address_string?: string;
    latitude?: number;
    longitude?: number;
    radius?: number;
    distance_unit?: string;
  }>(geo.custom_locations)
    .map((c) => {
      const where = (c?.name || c?.address_string || "").trim();
      const r = Number(c?.radius) || 0;
      // Meta's own unit, not an assumed one. An account set up in miles that
      // reads "+12km" is off by a factor of 1.6 and says so confidently.
      const unit = String(c?.distance_unit || "kilometer").startsWith("mile") ? "mi" : "km";
      if (where && r) return `${where} +${r}${unit}`;
      if (where) return where;
      // No name is normal — a pin dropped on a map has coordinates and nothing
      // else — and "17.4, 78.5 +5km" is still a better answer than silence.
      return c?.latitude != null && c?.longitude != null
        ? `${Number(c.latitude).toFixed(2)}, ${Number(c.longitude).toFixed(2)}${
            r ? ` +${r}${unit}` : ""
          }`
        : "";
    })
    .filter(Boolean);

  const levels = [
    custom,
    named(geo.places),
    named(geo.cities),
    named(geo.zips),
    named(geo.regions),
    asArray<string>(geo.countries).map(countryName),
    asArray<string>(geo.country_groups).map((g) => String(g).replace(/_/g, " ").toLowerCase()),
  ];

  const found = levels.find((l) => l.length > 0);
  if (!found) return null;

  const shown = found.slice(0, max);
  const rest = found.length - shown.length;
  // "+3 more" rather than a truncated list that reads as the whole of it.
  return shown.join(", ") + (rest > 0 ? ` +${rest} more` : "");
}
