/**
 * Turns a task page's `searchParams` into the filter object the data layer
 * wants, plus a normalised string map for the tabs/filter-bar to echo back.
 * Shared by /deliverables and /today so both behave identically.
 */
import { isServiceKey, type ServiceKey } from "./services";
import type { DeliverableFilters } from "./deliverables";

export type SearchParams = Record<string, string | string[] | undefined>;

export type ParsedTaskQuery = {
  /** Only the params that were actually set — echoed into links and inputs. */
  params: Record<string, string>;
  service: ServiceKey | null;
  filters: DeliverableFilters;
  hasFilters: boolean;
};

const KEYS = ["q", "category", "client", "status", "assignee", "due_from", "due_to", "month"] as const;

export function parseTaskQuery(sp: SearchParams): ParsedTaskQuery {
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");

  const params: Record<string, string> = {};
  for (const k of KEYS) {
    const v = get(k);
    if (v) params[k] = v;
  }

  const serviceRaw = get("service");
  const service = isServiceKey(serviceRaw) ? serviceRaw : null;
  if (service) params.service = service;

  const filters: DeliverableFilters = {
    q: params.q || undefined,
    category: params.category || undefined,
    clientId: params.client ? Number(params.client) : undefined,
    status: params.status || undefined,
    assignedTo: params.assignee ? Number(params.assignee) : undefined,
    dueFrom: params.due_from || undefined,
    dueTo: params.due_to || undefined,
    month: params.month || undefined,
    service: service ?? undefined,
  };

  return {
    params,
    service,
    filters,
    hasFilters: KEYS.some((k) => Boolean(params[k])),
  };
}
