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
): Promise<{ ok: boolean; rows: number; error?: string }> {
  const c = await queryOne<{
    id: number;
    company_name: string;
    meta_ad_account_id: string | null;
    ig_access_token: string | null;
  }>(
    "SELECT id, company_name, meta_ad_account_id, ig_access_token FROM clients WHERE id = ?",
    [clientId]
  );
  if (!c) return { ok: false, rows: 0, error: "Client not found." };

  const account = normaliseAccountId(c.meta_ad_account_id);
  if (!account) return { ok: false, rows: 0, error: "No ad account connected." };

  const token = (c.ig_access_token || "").trim() || env.meta.accessToken;
  if (!token) return { ok: false, rows: 0, error: "No Meta access token configured." };

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
      // Meta's own words. "(#278) Reading advertisements requires an access
      // token with the extended permission ads_read" is the message someone
      // needs to see, and paraphrasing it as "sync failed" hides the fix.
      return { ok: false, rows: 0, error: payload.error?.message || `HTTP ${res.status}` };
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
export async function syncAllAds(
  days = RESTATEMENT_DAYS
): Promise<{ synced: number; rows: number; failures: { client: string; error: string }[] }> {
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
  const failures: { client: string; error: string }[] = [];
  for (const c of clients) {
    const r = await syncClientAds(c.id, days);
    if (r.ok) {
      synced++;
      rows += r.rows;
    } else {
      failures.push({ client: c.company_name, error: r.error || "Unknown error" });
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

/** When the numbers were last refreshed from Meta, for the "as of" line. */
export async function lastAdSync(): Promise<string | null> {
  if (!(await hasTable("ad_insights"))) return null;
  const r = await queryOne<{ at: string | null }>("SELECT MAX(synced_at) AS at FROM ad_insights");
  return r?.at ? String(r.at) : null;
}
