import Link from "next/link";
import { BarChart3, Filter } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getScorecard } from "@/lib/reports";
import { crmClientIds } from "@/lib/crm";
import { SERVICE_KEYS, SERVICES, isServiceKey } from "@/lib/services";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { monthKey, cn } from "@/lib/utils";

export const metadata = { title: "Reports · NVK Hub" };
export const dynamic = "force-dynamic";

function pctTone(pct: number) {
  if (pct >= 80) return "from-emerald-500 to-green-500";
  if (pct >= 50) return "from-amber-500 to-yellow-500";
  return "from-rose-500 to-red-500";
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; service?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month || "") ? sp.month! : monthKey();
  const service = isServiceKey(sp.service) ? sp.service : undefined;
  const scopeIds = await crmClientIds(user);
  const rows = await getScorecard(month, service, scopeIds);

  const totals = rows.reduce(
    (a, r) => ({ total: a.total + r.total, approved: a.approved + r.approved }),
    { total: 0, approved: 0 }
  );
  const overallPct = totals.total ? Math.round((totals.approved / totals.total) * 100) : 0;

  // Only show service columns that actually saw work this month — keeps the
  // table readable for agencies running two services rather than six.
  const activeServices = SERVICE_KEYS.filter((k) =>
    rows.some((r) => r.services[k].total > 0)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BarChart3 className="h-6 w-6 text-primary" />
            Monthly scorecard
          </h1>
          <p className="text-sm text-muted-foreground">
            {totals.approved}/{totals.total} approved overall · {overallPct}%
            {service ? ` · ${SERVICES[service].label} only` : ""}
          </p>
        </div>
        <form method="GET" className="flex items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Month</label>
            <Input type="month" name="month" defaultValue={month} />
          </div>
          <div className="min-w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Service</label>
            <Select name="service" defaultValue={service ?? ""}>
              <option value="">All services</option>
              {SERVICE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SERVICES[k].label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            <Filter className="h-4 w-4" /> View
          </Button>
        </form>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">No clients to report.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Client</th>
                {activeServices.map((k) => (
                  <th key={k} className="text-center whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("h-2 w-2 rounded-full", SERVICES[k].dot)} />
                      {SERVICES[k].short}
                    </span>
                  </th>
                ))}
                <th className="text-center">Target</th>
                <th className="text-center">Approved</th>
                <th>Completion</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => {
                const target = r.monthly_deliverables || r.total || 0;
                const pct = target ? Math.min(100, Math.round((r.approved / target) * 100)) : 0;
                return (
                  <TR key={r.id}>
                    <TD>
                      <Link href={`/clients/${r.id}`} className="font-medium hover:text-primary hover:underline">
                        {r.company_name}
                      </Link>
                    </TD>
                    {activeServices.map((k) => (
                      <TD key={k} className="text-center tabular-nums">
                        {r.services[k].total === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          `${r.services[k].approved}/${r.services[k].total}`
                        )}
                      </TD>
                    ))}
                    <TD className="text-center tabular-nums">{target || "—"}</TD>
                    <TD className="text-center tabular-nums">
                      {r.approved}/{r.total}
                    </TD>
                    <TD>
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-full max-w-40 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full bg-gradient-to-r ${pctTone(pct)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">
                          {pct}%
                        </span>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
