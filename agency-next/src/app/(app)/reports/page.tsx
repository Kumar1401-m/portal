import Link from "next/link";
import { Pencil, User, ListFilter } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getCategoryScorecard, getReportServiceCounts } from "@/lib/reports";
import { crmClientIds } from "@/lib/crm";
import { isServiceKey, SERVICES, SERVICE_LIST } from "@/lib/services";
import { Card } from "@/components/ui/card";
import { MonthPicker } from "@/components/admin/month-picker";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { monthKey } from "@/lib/utils";

export const metadata = { title: "Reports · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * The percentage cell: bar on top, figure underneath, on a pink track — the
 * shape of the report this replaces.
 */
function Pct({ done, of }: { done: number; of: number }) {
  const pct = of ? Math.round((done / of) * 10000) / 100 : 0;
  const tone = pct >= 80 ? "bg-blue-700" : pct >= 40 ? "bg-red-500" : "bg-rose-400";
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-rose-200 dark:bg-rose-950/60">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mt-0.5 block text-xs tabular-nums">{pct}%</span>
    </div>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; service?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month || "") ? sp.month! : monthKey();
  // Posters and videos each get their own report; the tab is the difference.
  const service = isServiceKey(sp.service) ? sp.service : undefined;
  const scopeIds = await crmClientIds(user);
  const [{ rows, categories }, counts] = await Promise.all([
    getCategoryScorecard(month, scopeIds, service),
    getReportServiceCounts(month, scopeIds),
  ]);

  // S.No, client, tier, actions + 3 per content category.
  const cols = 4 + categories.length * 3;
  const heading = service ? `${SERVICES[service].label} — Clients List` : "Clients List";

  /**
   * Column widths as percentages of the container.
   *
   * Fixed pixel widths did two things wrong at once: they left the table
   * narrower than the page when there was one category (cramped headings with
   * empty space beside them) and wider than it when there were three (a
   * scrollbar). Percentages of a table-fixed layout always add up to the
   * container, so the space that exists gets used and none is invented.
   */
  const n = Math.max(categories.length, 1);
  const FIXED = 4 + 18 + 7 + 5; // S.No, client, tier, actions
  const group = (100 - FIXED) / n;
  const w = {
    sno: 4,
    client: 18,
    tier: 7,
    count: group * 0.22,
    approved: group * 0.28,
    pct: group * 0.5,
    actions: 5,
  };
  /**
   * Past three categories, dividing the width evenly leaves columns around
   * 40px — narrower than the numbers in them. Beyond that the table sizes to
   * its content and the panel scrolls, which is legible; squashed is not.
   */
  const fits = n <= 3;
  const pc = (x: number) => (fits ? `${x.toFixed(3)}%` : undefined);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden p-0">
        <div className="bg-indigo-700 px-5 py-3">
          <h1 className="font-semibold text-white">{heading}</h1>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4">
          <MonthPicker month={month} basePath="/reports" extra={{ service }} />

          {/* Posters and videos each get their own report. A select rather
              than a tab bar — it's one control beside the month, not a second
              row of navigation above the page. */}
          <form method="GET" action="/reports" className="flex items-end gap-2">
            <input type="hidden" name="month" value={month} />
            <div className="relative">
              <span className="absolute -top-2 left-2 z-10 bg-card px-1 text-[11px] text-muted-foreground">
                Service
              </span>
              <Select name="service" defaultValue={service ?? ""} className="h-[38px] w-44">
                <option value="">All services ({counts.all})</option>
                {SERVICE_LIST.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} ({counts[s.key]})
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              View
            </Button>
          </form>
        </div>

        <div className={fits ? "w-full" : "w-full overflow-x-auto"}>
          <table className={`w-full text-sm ${fits ? "table-fixed" : "min-w-[70rem]"}`}>
            <thead className="border-b border-border">
              <tr className="[&_th]:px-3 [&_th]:py-3 [&_th]:align-top [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:leading-snug [&_th]:text-primary">
                <th style={{ width: pc(w.sno) }}>S.No</th>
                <th style={{ width: pc(w.client) }}>
                  <span className="inline-flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 shrink-0" /> Name of the Client
                    <ListFilter className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  </span>
                </th>
                <th style={{ width: pc(w.tier) }}>Category</th>
                {categories.map((c) => [
                  <th key={`h1-${c}`} style={{ width: pc(w.count) }}>
                    No Of {c}
                  </th>,
                  <th key={`h2-${c}`} style={{ width: pc(w.approved) }}>
                    Total {c} Approved
                  </th>,
                  <th key={`h3-${c}`} style={{ width: pc(w.pct) }}>
                    Percent of {c} Approved (%)
                  </th>,
                ])}
                <th style={{ width: pc(w.actions) }} className="text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={cols} className="px-3 py-10 text-center text-muted-foreground">
                    Nothing recorded for this month.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-3 align-top text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-3 align-top">
                      <Link
                        href={`/reports/${r.id}?month=${month}${service ? `&service=${service}` : ""}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {r.company_name}
                      </Link>
                    </td>
                    <td className="px-3 py-3 align-top">{r.tier || "—"}</td>
                    {categories.map((c) => {
                      const t = r.categories[c] ?? { total: 0, approved: 0 };
                      return [
                        <td key={`c1-${c}`} className="px-3 py-3 align-top tabular-nums">
                          {t.total}
                        </td>,
                        <td key={`c2-${c}`} className="px-3 py-3 align-top tabular-nums">
                          {t.approved}
                        </td>,
                        <td key={`c3-${c}`} className="px-3 py-3 align-top">
                          <Pct done={t.approved} of={t.total} />
                        </td>,
                      ];
                    })}
                    <td className="px-3 py-3 text-right align-top">
                      <Link
                        href={`/reports/${r.id}?month=${month}${service ? `&service=${service}` : ""}`}
                        aria-label={`Open ${r.company_name}`}
                        title={`Open ${r.company_name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-pink-600 transition-colors hover:bg-pink-500/10"
                      >
                        <Pencil className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
