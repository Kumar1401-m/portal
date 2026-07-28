import {
  Users,
  ClipboardList,
  CheckCircle2,
  IndianRupee,
  AlertTriangle,
  CalendarClock,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import {
  getAdminDashboard,
  getCrmDashboard,
  getProductionSummary,
  getServiceMix,
} from "@/lib/queries";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceDot } from "@/components/ui/service-badge";
import { ProductionSummary } from "@/components/admin/production-summary";
import { ServiceMix } from "@/components/admin/service-mix";
import { money, label, fmtDate } from "@/lib/utils";

export const metadata = { title: "Dashboard · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const isCrm = user.role === "crm";
  const scopeIds = await crmClientIds(user);

  // A crm gets a scoped, money-free dashboard; admins get the agency-wide one.
  const [d, production, serviceMix] = await Promise.all([
    isCrm ? getCrmDashboard(scopeIds) : getAdminDashboard(),
    getProductionSummary(scopeIds),
    isCrm ? Promise.resolve([]) : getServiceMix(),
  ]);

  const admin = isCrm ? null : (d as Awaited<ReturnType<typeof getAdminDashboard>>);

  const monthPct = d.deliverables.month_total
    ? Math.round((d.deliverables.month_completed / d.deliverables.month_total) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {user.name.split(" ")[0]} 👋
        </h1>
        <p className="text-sm text-muted-foreground">
          {isCrm
            ? "Here's what's happening across your clients today."
            : "Here's what's happening across the agency today."}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Active clients"
          value={d.clients.active}
          hint={
            admin
              ? `${d.clients.total} total · ${admin.clients.new_30d} new in 30d`
              : `${d.clients.total} assigned to you`
          }
          icon={Users}
          tone="indigo"
        />
        <StatCard
          title="This month's content"
          value={`${d.deliverables.month_completed}/${d.deliverables.month_total}`}
          hint={`${monthPct}% completed`}
          icon={ClipboardList}
          tone="violet"
        />
        <StatCard
          title="Awaiting approval"
          value={d.pending_approvals}
          hint={admin ? `${admin.changes_requested} changes requested` : "across your clients"}
          icon={CheckCircle2}
          tone="amber"
        />
        {admin ? (
          <StatCard
            title="Revenue this month"
            value={money(admin.payments.month_received)}
            hint={`${money(admin.payments.pending_amount)} pending`}
            icon={IndianRupee}
            tone="emerald"
          />
        ) : null}
      </div>

      {/* Secondary row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Due today" value={d.deliverables.today} icon={CalendarClock} tone="sky" />
        <StatCard title="Upcoming" value={d.deliverables.upcoming} icon={CalendarClock} tone="indigo" />
        <StatCard title="Overdue" value={d.deliverables.overdue} icon={AlertTriangle} tone="rose" />
      </div>

      {/* Workload split by service — colour-coded shortcuts into the task tabs */}
      {!isCrm ? <ServiceMix rows={serviceMix} /> : null}

      {/* Per-client production summary (reference image 4) */}
      <ProductionSummary rows={production} />

      <div className="grid gap-6">
        {/* Upcoming tasks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-muted-foreground" />
              Upcoming deliverables
            </CardTitle>
          </CardHeader>
          <CardContent>
            {d.upcoming_tasks.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing scheduled. You&apos;re all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {d.upcoming_tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-3">
                    <ServiceDot task={t} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t.company_name}
                        {t.content_category ? ` · ${t.content_category}` : ""}
                      </p>
                    </div>
                    <Badge tone={statusTone(t.status)}>{label(t.status)}</Badge>
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                      {fmtDate(t.due_date)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>

      {/* Client progress — the production summary above already covers this
          for a crm, scoped to their own clients. */}
      {admin ? (
      <Card>
        <CardHeader>
          <CardTitle>This month&apos;s client progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {admin.client_progress.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No active clients yet.
            </p>
          ) : (
            admin.client_progress.map((c) => {
              const target = c.monthly_deliverables || c.planned || 0;
              const pct = target ? Math.min(100, Math.round((c.completed / target) * 100)) : 0;
              return (
                <div key={c.id}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{c.company_name}</span>
                    <span className="text-muted-foreground">
                      {c.completed}/{target || "—"} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
      ) : null}
    </div>
  );
}
