import Link from "next/link";
import { ClipboardList, CheckCircle2, Clock, FileText, ArrowRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalOverview } from "@/lib/portal";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceDot } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { money, label } from "@/lib/utils";

export const metadata = { title: "NVK Media" };
export const dynamic = "force-dynamic";

export default async function PortalDashboard() {
  const user = await requireUser(["client"]);
  const overview = user.clientId ? await getPortalOverview(user.clientId) : null;

  if (!overview) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Your client profile isn&apos;t linked yet. Please contact the agency.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hi {overview.company_name} 👋</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s where your content stands.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Content this month" value={overview.month.total} icon={ClipboardList} tone="indigo" />
        <StatCard title="Approved" value={overview.month.approved} icon={CheckCircle2} tone="emerald" />
        <StatCard title="Awaiting your review" value={overview.month.awaiting} icon={Clock} tone="amber" />
        <StatCard
          title="Invoices due"
          value={money(overview.invoices.pending_total)}
          hint={`${overview.invoices.pending_count} unpaid`}
          icon={FileText}
          tone="rose"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" /> Waiting for your review
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overview.awaiting_items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing needs your review right now. 🎉
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {overview.awaiting_items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 py-3">
                  <ServiceDot task={it} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.status === "content_review" ? "Content approval" : "Final approval"}
                      {it.content_category ? ` · ${it.content_category}` : ""}
                    </p>
                  </div>
                  <Badge tone={statusTone(it.status)}>{label(it.status)}</Badge>
                  <Link
                    href={`/portal/content/${it.id}`}
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Review <ArrowRight className="h-4 w-4" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
