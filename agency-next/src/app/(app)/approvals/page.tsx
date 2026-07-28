import Link from "next/link";
import { CheckCircle2, ArrowRight } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getDeliverables, getApprovalCounts, getServiceCounts } from "@/lib/deliverables";
import { isServiceKey } from "@/lib/services";
import { quickStatus } from "../deliverables/actions";
import { Card } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { ServiceTabs } from "@/components/admin/service-tabs";
import { ServiceBadge } from "@/components/ui/service-badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { fmtDate, cn } from "@/lib/utils";

export const metadata = { title: "Approvals · NVK Hub" };
export const dynamic = "force-dynamic";

type TabKey = "content" | "final" | "changes" | "approved";

const TABS: {
  key: TabKey;
  label: string;
  status: string;
  action?: { label: string; status: string };
}[] = [
  { key: "content", label: "Content review", status: "content_review", action: { label: "Approve content", status: "approved" } },
  { key: "final", label: "Final review", status: "review", action: { label: "Approve", status: "approved" } },
  { key: "changes", label: "Changes requested", status: "changes_requested", action: { label: "Mark resolved", status: "resolved" } },
  { key: "approved", label: "Recently approved", status: "approved", action: { label: "Schedule", status: "scheduled" } },
];

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; service?: string }>;
}) {
  await requireUser(ADMIN_ROLES);
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.tab) ?? TABS[0]) as (typeof TABS)[number];
  const service = isServiceKey(sp.service) ? sp.service : null;
  const filters = { status: active.status, service: service ?? undefined };

  const [rows, counts, serviceCounts] = await Promise.all([
    getDeliverables(filters),
    getApprovalCounts(),
    getServiceCounts(filters),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CheckCircle2 className="h-6 w-6 text-primary" />
          Approvals
        </h1>
        <p className="text-sm text-muted-foreground">
          Track content through the two approval gates.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border">
        {TABS.map((t) => {
          const isActive = t.key === active.key;
          const count = counts[t.key];
          return (
            <Link
              key={t.key}
              href={`/approvals?tab=${t.key}${service ? `&service=${service}` : ""}`}
              className={cn(
                "flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                  isActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Narrow the gate to a single service — no mixed task types. */}
      <ServiceTabs
        basePath="/approvals"
        active={service}
        counts={serviceCounts}
        params={{ tab: active.key }}
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            Nothing in “{active.label}”.
          </p>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Title</th>
                <th>Client</th>
                <th>Service &amp; category</th>
                <th>Due</th>
                <th className="text-right">Action</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <Link
                      href={`/deliverables/${d.id}`}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {d.title}
                    </Link>
                  </TD>
                  <TD>{d.company_name}</TD>
                  <TD>
                    <ServiceBadge task={d} category={d.content_category} />
                  </TD>
                  <TD className="text-muted-foreground">{fmtDate(d.due_date)}</TD>
                  <TD>
                    <div className="flex items-center justify-end gap-2">
                      {active.action ? (
                        <form action={quickStatus}>
                          <input type="hidden" name="deliverable_id" value={d.id} />
                          <input type="hidden" name="status" value={active.action.status} />
                          <Button type="submit" size="sm" variant="secondary">
                            {active.action.label}
                          </Button>
                        </form>
                      ) : null}
                      <Link
                        href={`/deliverables/${d.id}`}
                        className={buttonClasses({ variant: "ghost", size: "sm" })}
                      >
                        Review <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
