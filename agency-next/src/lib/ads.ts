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
  if (!Array.isArray(actions)) return 0;
  for (const type of LEAD_ACTIONS) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) return Math.max(0, Math.trunc(Number(hit.value) || 0));
  }
  return 0;
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

  const values: (string | number)[] = [];
  const placeholders: string[] = [];
  for (const r of rows) {
    if (!r.date_start) continue;
    placeholders.push("(?,?,?,?,?,?,?,?,NOW())");
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
       (client_id, date, spend, currency, impressions, reach, clicks, leads, synced_at)
     VALUES ${placeholders.join(",")}
     ON DUPLICATE KEY UPDATE
       spend = VALUES(spend), currency = VALUES(currency),
       impressions = VALUES(impressions), reach = VALUES(reach),
       clicks = VALUES(clicks), leads = VALUES(leads), synced_at = NOW()`,
    values
  );
  return { ok: true, rows: placeholders.length };
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
  reach: number;
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
    reach: string;
    clicks: string;
    leads: string;
    last_day: string;
  }>(
    `SELECT client_id, currency,
            SUM(spend)             AS spend,
            SUM(impressions)       AS impressions,
            SUM(reach)             AS reach,
            SUM(clicks)            AS clicks,
            SUM(leads)             AS leads,
            MAX(date)              AS last_day
       FROM ad_insights
      WHERE date BETWEEN ? AND ?
      GROUP BY client_id, currency`,
    [from, to]
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
        reach: Number(a.reach) || 0,
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
export async function lastAdSync(): Promise<string | null> {
  if (!(await hasTable("ad_insights"))) return null;
  const r = await queryOne<{ at: string | null }>("SELECT MAX(synced_at) AS at FROM ad_insights");
  return r?.at ? String(r.at) : null;
}
