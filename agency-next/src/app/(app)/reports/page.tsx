import Link from "next/link";
import { BarChart3, SquarePen, User } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getCategoryScorecard } from "@/lib/reports";
import { crmClientIds } from "@/lib/crm";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { MonthPicker } from "@/components/admin/month-picker";
import { monthKey } from "@/lib/utils";

export const metadata = { title: "Reports · NVK Hub" };
export const dynamic = "force-dynamic";

/** A percentage with its bar, as on the old clients list. */
function Pct({ done, of }: { done: number; of: number }) {
  const pct = of ? Math.round((done / of) * 1000) / 10 : 0;
  const tone = pct >= 80 ? "bg-blue-600" : pct >= 50 ? "bg-rose-500" : "bg-rose-400";
  return (
    <div className="min-w-32">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-rose-200/70 dark:bg-rose-950/50">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month || "") ? sp.month! : monthKey();
  const scopeIds = await crmClientIds(user);
  const { rows, categories } = await getCategoryScorecard(month, scopeIds);

  // S.No + client + 3 per category (count, approved, %) + actions.
  const cols = 3 + categories.length * 3;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3 className="h-6 w-6 text-primary" />
          Clients list
        </h1>
        <MonthPicker month={month} basePath="/reports" />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="bg-gradient-to-r from-orange-600 to-amber-600 px-5 py-3">
          <h2 className="font-semibold text-white">Clients list</h2>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr className="[&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-3 [&_th]:align-bottom [&_th]:text-xs [&_th]:font-semibold [&_th]:text-primary">
                <th className="text-left">S.No</th>
                <th className="text-left">
                  <span className="inline-flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5" /> Name of the client
                  </span>
                </th>
                {/* Each category reads count → approved → %, left to right, the
                    way the old report did. */}
                {categories.map((c) => [
                  <th key={`h1-${c}`} className="text-center">
                    No of {c}
                  </th>,
                  <th key={`h2-${c}`} className="text-center">
                    Total {c} approved
                  </th>,
                  <th key={`h3-${c}`} className="text-left">
                    Percent of {c} approved (%)
                  </th>,
                ])}
                <th className="text-right">Actions</th>
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
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-3 py-3 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-3">
                      <Link
                        href={`/reports/${r.id}?month=${month}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {r.company_name}
                      </Link>
                    </td>
                    {categories.map((c) => {
                      const t = r.categories[c] ?? { total: 0, approved: 0 };
                      return [
                        <td key={`c1-${c}`} className="px-3 py-3 text-center tabular-nums">
                          {t.total}
                        </td>,
                        <td key={`c2-${c}`} className="px-3 py-3 text-center tabular-nums">
                          {t.approved}
                        </td>,
                        <td key={`c3-${c}`} className="px-3 py-3">
                          <Pct done={t.approved} of={t.total} />
                        </td>,
                      ];
                    })}
                    <td className="px-3 py-3 text-right">
                      <Link
                        href={`/reports/${r.id}?month=${month}`}
                        aria-label={`Open ${r.company_name}`}
                        title={`Open ${r.company_name}`}
                        className={buttonClasses({ variant: "ghost", size: "icon" })}
                      >
                        <SquarePen className="h-4 w-4 text-primary" />
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
