/** Task category reads (admin-managed list in `task_categories`). */
import "server-only";
import { query } from "./db";
import {
  SERVICE_KEYS,
  DEFAULT_CATEGORIES,
  isServiceKey,
  type ServiceKey,
} from "./services";

export type CategoryRow = {
  id: number;
  service: ServiceKey;
  name: string;
  sort_order: number;
  is_active: number;
};

export type CategoryMap = Record<ServiceKey, CategoryRow[]>;

const emptyMap = (): CategoryMap =>
  Object.fromEntries(SERVICE_KEYS.map((k) => [k, [] as CategoryRow[]])) as CategoryMap;

/**
 * All categories grouped by service. Falls back to the built-in defaults if the
 * table isn't there yet (migration not run), so the forms never come up empty.
 */
export async function getCategoryMap(includeInactive = false): Promise<CategoryMap> {
  const map = emptyMap();
  try {
    const rows = await query<CategoryRow>(
      `SELECT id, service, name, sort_order, is_active FROM task_categories
       ${includeInactive ? "" : "WHERE is_active = 1"}
       ORDER BY sort_order, name`
    );
    for (const r of rows) {
      if (isServiceKey(r.service)) map[r.service].push({ ...r, sort_order: Number(r.sort_order) });
    }
    if (rows.length) return map;
  } catch (err) {
    console.warn("task_categories unavailable, using defaults:", err instanceof Error ? err.message : err);
  }
  // Fallback — synthetic rows (negative ids mark them as not-yet-persisted).
  for (const k of SERVICE_KEYS) {
    map[k] = DEFAULT_CATEGORIES[k].map((name, i) => ({
      id: -(i + 1),
      service: k,
      name,
      sort_order: i,
      is_active: 1,
    }));
  }
  return map;
}

/** Active category names for one service — for the filter and form dropdowns. */
export async function getCategoryNames(service: ServiceKey): Promise<string[]> {
  const map = await getCategoryMap();
  return map[service].map((c) => c.name);
}

/**
 * Every distinct category actually in use, so the "All tasks" filter can still
 * offer a category dropdown that includes legacy / renamed values.
 */
export async function getUsedCategories(): Promise<string[]> {
  const rows = await query<{ content_category: string }>(
    `SELECT DISTINCT content_category FROM deliverables
     WHERE content_category IS NOT NULL AND content_category <> ''
     ORDER BY content_category`
  );
  return rows.map((r) => r.content_category);
}
