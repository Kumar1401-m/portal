import Link from "next/link";
import { Pencil, User, ListFilter } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getCategoryScorecard, getReportServiceCounts } from "@/lib/reports";
import { crmClientIds } from "@/lib/crm";
import { isServiceKey, SERVICES } from "@/lib/services";
import { Card } from "@/components/ui/card";
import { MonthPicker } from "@/components/admin/month-picker";
import { ServiceTabs } from "@/components/admin/service-tabs";
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
    <div className="min-w-[5rem]">
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
  const heading = service ? `${SERVICES[service].label} — clients list` : "Clients list";

  return (
    <div className="space-y-4">
      <ServiceTabs
        basePath="/reports"
        active={service ?? null}
        counts={counts}
        params={{ month }}
      />

      <Card className="overflow-hidden p-0">
        <div className="bg-indigo-700 px-5 py-3">
          <h1 className="font-semibold text-white">{heading}</h1>
        </div>

        <div className="border-b border-border px-5 py-4">
          <MonthPicker month={month} basePath="/reports" extra={{ service }} />
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm">
            {/* Headers wrap rather than forcing the table wider than the page —
                that is what put a scrollbar under it before. */}
            <thead className="border-b border-border">
              <tr className="[&_th]:px-2 [&_th]:py-3 [&_th]:align-top [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:leading-snug [&_th]:text-primary">
                <th className="w-10">S.No</th>
                <th className="min-w-32">
                  <span className="inline-flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5" /> Name of the Client
                    <ListFilter className="h-3.5 w-3.5 opacity-60" />
                  </span>
                </th>
                <th className="w-16">Category</th>
                {categories.map((c) => [
                  <th key={`h1-${c}`} className="w-16">
                    No Of {c}
                  </th>,
                  <th key={`h2-${c}`} className="w-20">
                    Total {c} Approved
                  </th>,
                  <th key={`h3-${c}`} className="w-28">
                    Percent of {c} Approved (%)
                  </th>,
                ])}
                <th className="w-14 text-right">Actions</th>
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
                    <td className="px-2 py-3 align-top text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-3 align-top">
                      <Link
                        href={`/reports/${r.id}?month=${month}${service ? `&service=${service}` : ""}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {r.company_name}
                      </Link>
                    </td>
                    <td className="px-2 py-3 align-top">{r.tier || "—"}</td>
                    {categories.map((c) => {
                      const t = r.categories[c] ?? { total: 0, approved: 0 };
                      return [
                        <td key={`c1-${c}`} className="px-2 py-3 align-top tabular-nums">
                          {t.total}
                        </td>,
                        <td key={`c2-${c}`} className="px-2 py-3 align-top tabular-nums">
                          {t.approved}
                        </td>,
                        <td key={`c3-${c}`} className="px-2 py-3 align-top">
                          <Pct done={t.approved} of={t.total} />
                        </td>,
                      ];
                    })}
                    <td className="px-2 py-3 text-right align-top">
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
