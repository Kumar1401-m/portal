/**
 * Reading and writing the analytics dashboard's filter state.
 *
 * The filters live in the URL, not in React state. That is what makes a
 * filtered view shareable, bookmarkable and survivable across a refresh — and
 * it means the page can stay a server component, with the filter bar the only
 * client-side piece.
 *
 * Shared by both, so this file must not be server-only.
 */

export type DateRangeKey = "7d" | "30d" | "90d" | "this_month" | "last_month" | "custom";

export type ParsedFilters = {
  clientId: number | null;
  from: string;
  to: string;
  range: DateRangeKey;
  platform: string;
  campaign: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));

export const RANGE_OPTIONS: { key: DateRangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom range" },
];

/** Resolve a preset to concrete dates. `custom` keeps whatever was passed in. */
export function resolveRange(
  range: DateRangeKey,
  from?: string | null,
  to?: string | null
): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  switch (range) {
    case "7d":
      return { from: daysAgo(6), to: iso(now) };
    case "90d":
      return { from: daysAgo(89), to: iso(now) };
    case "this_month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
    case "last_month": {
      const firstThis = new Date(Date.UTC(y, m, 1));
      const lastPrev = new Date(firstThis.getTime() - 86400000);
      return {
        from: iso(new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1))),
        to: iso(lastPrev),
      };
    }
    case "custom":
      // Falls back to the 30-day default per side, so a half-filled custom
      // range still produces a valid window rather than an error.
      return { from: from || daysAgo(29), to: to || iso(now) };
    default:
      return { from: daysAgo(29), to: iso(now) };
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `searchParams` object into filters.
 *
 * Every value is validated rather than trusted: these end up in SQL date
 * comparisons, and "whatever was in the query string" is not an acceptable
 * input to those even when it is bound as a parameter.
 */
export function parseFilters(params: Record<string, string | string[] | undefined>): ParsedFilters {
  const one = (k: string): string | null => {
    const v = params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.length ? s : null;
  };

  const rangeRaw = one("range") as DateRangeKey | null;
  const range: DateRangeKey =
    rangeRaw && RANGE_OPTIONS.some((r) => r.key === rangeRaw) ? rangeRaw : "30d";

  const rawFrom = one("from");
  const rawTo = one("to");
  const resolved = resolveRange(
    range,
    rawFrom && DATE_RE.test(rawFrom) ? rawFrom : null,
    rawTo && DATE_RE.test(rawTo) ? rawTo : null
  );

  // A backwards range returns nothing and looks like "we have no data", which
  // is a much more confusing failure than silently swapping the ends.
  const [from, to] =
    resolved.from <= resolved.to ? [resolved.from, resolved.to] : [resolved.to, resolved.from];

  const clientIdRaw = Number(one("client"));

  return {
    clientId: Number.isFinite(clientIdRaw) && clientIdRaw > 0 ? clientIdRaw : null,
    from,
    to,
    range,
    platform: one("platform") || "instagram",
    campaign: one("campaign"),
  };
}

/** Rebuild the query string with one or more values changed. */
export function buildQuery(current: ParsedFilters, patch: Partial<ParsedFilters>): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();

  if (next.clientId) params.set("client", String(next.clientId));
  if (next.range !== "30d") params.set("range", next.range);
  // Explicit dates only travel with a custom range — leaving them on a preset
  // makes a stale `from` silently override the preset the user just picked.
  if (next.range === "custom") {
    params.set("from", next.from);
    params.set("to", next.to);
  }
  if (next.platform && next.platform !== "instagram") params.set("platform", next.platform);
  if (next.campaign) params.set("campaign", next.campaign);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** "1 Jul – 31 Jul 2026" for the period caption. */
export function formatRange(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  const sameYear = f.getUTCFullYear() === t.getUTCFullYear();
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  return `${fmt(f, !sameYear)} – ${fmt(t, true)}`;
}
