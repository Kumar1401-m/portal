/** Reporting queries — monthly client scorecard, split by service. */
import "server-only";
import { query } from "./db";
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
