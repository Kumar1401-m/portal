/** Reporting queries — monthly client scorecard, split by service. */
import "server-only";
import { query, queryOne, hasColumn } from "./db";
import { SERVICE_KEYS, type ServiceKey } from "./services";

const n = (v: unknown) => Number(v ?? 0);

export type ServiceTally = { total: number; approved: number };

export type ScorecardRow = {
  id: number;
  company_name: string;
  monthly_deliverables: number;
  total: number;
  approved: number;
  /** Per-service approved/total for the month. */
  services: Record<ServiceKey, ServiceTally>;
};

const DONE = "('approved','scheduled','posted','completed')";

/**
 * `service` is NULL on rows created before the taxonomy existed — fold those in
 * the same way `serviceOf()` does so no work goes uncounted.
 */
const SERVICE_EXPR = `COALESCE(NULLIF(d.service,''),
  IF(LOWER(COALESCE(d.video_type,'')) = 'poster','poster_designing','video_editing'))`;

const emptyTallies = (): Record<ServiceKey, ServiceTally> =>
  Object.fromEntries(
    SERVICE_KEYS.map((k) => [k, { total: 0, approved: 0 }])
  ) as Record<ServiceKey, ServiceTally>;

/**
 * Per-client content scorecard for a month (YYYY-MM), optionally one service.
 * `crmClientIds`: null/omitted = unrestricted, [] = no access to any client.
 */
export async function getScorecard(
  month: string,
  service?: ServiceKey,
  crmClientIds?: number[] | null
): Promise<ScorecardRow[]> {
  if (crmClientIds && crmClientIds.length === 0) return [];

  const cols = SERVICE_KEYS.map(
    (k) => `COALESCE(SUM(${SERVICE_EXPR} = '${k}'),0) AS ${k}_total,
            COALESCE(SUM(${SERVICE_EXPR} = '${k}' AND d.status IN ${DONE}),0) AS ${k}_approved`
  ).join(",\n       ");

  const joinExtra = service ? ` AND ${SERVICE_EXPR} = ?` : "";
  const params: (string | number)[] = service ? [month, service] : [month];
  const clientScope =
    crmClientIds && crmClientIds.length
      ? ` AND c.id IN (${crmClientIds.map(() => "?").join(",")})`
      : "";
  if (crmClientIds && crmClientIds.length) params.push(...crmClientIds);

  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, c.company_name, c.monthly_deliverables,
       COALESCE(COUNT(d.id),0) AS total,
       COALESCE(SUM(d.status IN ${DONE}),0) AS approved,
       ${cols}
     FROM clients c
     LEFT JOIN deliverables d ON d.client_id = c.id AND d.month_key = ?${joinExtra}
     WHERE c.status != 'churned'${clientScope}
     GROUP BY c.id ORDER BY c.company_name`,
    params
  );

  return rows.map((r) => {
    const services = emptyTallies();
    for (const k of SERVICE_KEYS) {
      services[k] = { total: n(r[`${k}_total`]), approved: n(r[`${k}_approved`]) };
    }
    return {
      id: n(r.id),
      company_name: String(r.company_name),
      monthly_deliverables: n(r.monthly_deliverables),
      total: n(r.total),
      approved: n(r.approved),
      services,
    };
  });
}

/* ------------------- Clients list, split by category ------------------- */

export type CategoryTally = { total: number; approved: number };

export type CategoryScorecardRow = {
  id: number;
  company_name: string;
  monthly_deliverables: number;
  /** The agency's own A / B / C tier; blank until it's set on the client. */
  tier: string;
  total: number;
  approved: number;
  /** Keyed by content category name, e.g. "Educational Reels". */
  categories: Record<string, CategoryTally>;
};

const UNCATEGORISED = "Uncategorised";
const CAT_EXPR = `COALESCE(NULLIF(d.content_category,''),'${UNCATEGORISED}')`;

/**
 * The monthly clients list: one row per client, and for every content category
 * that saw work this month, how many were produced and how many the client has
 * approved.
 *
 * Categories are admin-managed (Settings -> Task categories), so the columns
 * are derived from the month's data rather than hardcoded — rename or add one
 * and the report follows.
 */
export async function getCategoryScorecard(
  month: string,
  crmClientIds?: number[] | null,
  service?: ServiceKey
): Promise<{ rows: CategoryScorecardRow[]; categories: string[] }> {
  if (crmClientIds && crmClientIds.length === 0) return { rows: [], categories: [] };

  // The service filter belongs on the JOIN, not the WHERE: on a LEFT JOIN a
  // WHERE clause would drop clients with no work in that service, and showing
  // that they have none is the point of the list.
  const serviceJoin = service ? ` AND ${SERVICE_EXPR} = ?` : "";
  const params: (string | number)[] = [month];
  if (service) params.push(service);
  const clientScope =
    crmClientIds && crmClientIds.length
      ? ` AND c.id IN (${crmClientIds.map(() => "?").join(",")})`
      : "";
  if (crmClientIds && crmClientIds.length) params.push(...crmClientIds);

  // The tier column arrived later than the rest; a database that hasn't run
  // the migration still gets the report, just with the column blank.
  const tierCol = (await hasColumn("clients", "category")) ? "c.category" : "''";

  const raw = await query<Record<string, unknown>>(
    `SELECT c.id, c.company_name, c.monthly_deliverables, ${tierCol} AS tier,
            ${CAT_EXPR} AS cat,
            COUNT(d.id) AS total,
            COALESCE(SUM(d.status IN ${DONE}),0) AS approved
       FROM clients c
       LEFT JOIN deliverables d
         ON d.client_id = c.id AND d.month_key = ?${serviceJoin}
        AND d.status NOT IN ('cancelled','rejected')
      WHERE c.status != 'churned'${clientScope}
      GROUP BY c.id, cat
      ORDER BY c.company_name`,
    params
  );

  const byClient = new Map<number, CategoryScorecardRow>();
  const seen = new Set<string>();

  for (const r of raw) {
    const id = n(r.id);
    let row = byClient.get(id);
    if (!row) {
      row = {
        id,
        company_name: String(r.company_name),
        monthly_deliverables: n(r.monthly_deliverables),
        tier: String(r.tier ?? ""),
        total: 0,
        approved: 0,
        categories: {},
      };
      byClient.set(id, row);
    }
    // The LEFT JOIN yields one empty row per client with no work at all; it
    // carries the fallback category name and a count of zero.
    const total = n(r.total);
    if (total === 0) continue;
    const cat = String(r.cat);
    seen.add(cat);
    row.categories[cat] = { total, approved: n(r.approved) };
    row.total += total;
    row.approved += n(r.approved);
  }

  // Uncategorised sorts last; the rest alphabetically.
  const categories = [...seen].sort((a, b) =>
    a === UNCATEGORISED ? 1 : b === UNCATEGORISED ? -1 : a.localeCompare(b)
  );
  return { rows: [...byClient.values()], categories };
}

/* --------------------- One client's month of work --------------------- */

export type ClientMonthTask = {
  id: number;
  title: string;
  description: string | null;
  content_category: string | null;
  video_type: string | null;
  service: string | null;
  promotion_type: string | null;
  scheduled_at: string | null;
  due_date: string | null;
  raw_drive_link: string | null;
  edited_link: string | null;
  thumbnail_url: string | null;
  status: string;
  reject_reason: string | null;
};

/** Every task a client has in one month, in the order they're due to go out. */
export async function getClientMonth(
  clientId: number,
  month: string,
  service?: ServiceKey
): Promise<ClientMonthTask[]> {
  const params: (string | number)[] = [clientId, month];
  if (service) params.push(service);
  return query<ClientMonthTask>(
    `SELECT d.id, d.title, d.description, d.content_category, d.video_type, d.service,
            d.promotion_type, d.scheduled_at, d.due_date, d.raw_drive_link, d.edited_link,
            d.thumbnail_url, d.status, d.reject_reason
       FROM deliverables d
      WHERE d.client_id = ? AND d.month_key = ?${service ? ` AND ${SERVICE_EXPR} = ?` : ""}
      ORDER BY (COALESCE(d.scheduled_at, d.due_date) IS NULL),
               COALESCE(d.scheduled_at, d.due_date) ASC, d.id ASC`,
    params
  );
}

/** Tab badges for the reports list: how many tasks per service this month. */
export async function getReportServiceCounts(
  month: string,
  crmClientIds?: number[] | null
): Promise<Record<ServiceKey | "all", number>> {
  const empty = Object.fromEntries(
    [...SERVICE_KEYS, "all"].map((k) => [k, 0])
  ) as Record<ServiceKey | "all", number>;
  if (crmClientIds && crmClientIds.length === 0) return empty;

  const params: (string | number)[] = [month];
  const scope =
    crmClientIds && crmClientIds.length
      ? ` AND d.client_id IN (${crmClientIds.map(() => "?").join(",")})`
      : "";
  if (crmClientIds && crmClientIds.length) params.push(...crmClientIds);

  const cols = SERVICE_KEYS.map(
    (k) => `COALESCE(SUM(${SERVICE_EXPR} = '${k}'),0) AS ${k}`
  ).join(",\n       ");

  const row = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS all_count,
       ${cols}
     FROM deliverables d
     WHERE d.month_key = ? AND d.status NOT IN ('cancelled','rejected')${scope}`,
    params
  );
  const out = { ...empty, all: n(row?.all_count) };
  for (const k of SERVICE_KEYS) out[k] = n(row?.[k]);
  return out;
}
