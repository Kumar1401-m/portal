import Link from "next/link";
import { CheckCircle2, ArrowRight } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getDeliverables, getApprovalCounts, getServiceCounts } from "@/lib/deliverables";
import {
  getApprovalBoard,
  getApprovalCounts as getWaApprovalCounts,
} from "@/lib/whatsapp-approvals";
import { env } from "@/lib/env";
import { ApprovalBoard } from "./approval-board";
import { crmClientIds } from "@/lib/crm";
import { isServiceKey } from "@/lib/services";
import { quickStatus } from "../deliverables/actions";
import { approveContentToTeam } from "./content-actions";
import { Card } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { ServiceTabs } from "@/components/admin/service-tabs";
import { ServiceBadge } from "@/components/ui/service-badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { fmtDate, cn } from "@/lib/utils";

export const metadata = { title: "Approvals · NVK Hub" };
export const dynamic = "force-dynamic";

type TabKey = "written" | "content" | "final" | "changes" | "approved" | "scheduled" | "posted";

const TABS: {
  key: TabKey;
  label: string;
  status: string;
  action?: { label: string; status: string };
  /** Match on either posted column rather than the workflow status alone. */
  postedEither?: boolean;
  /** Written and waiting on the super admin, who decides where it goes next. */
  contentWritten?: boolean;
}[] = [
  /*
   * First, because it is the step before everything below it.
   *
   * Somebody writes the copy and it lands here, and the super admin releases
   * it to whoever makes it. It used to be a choice — to the client for
   * sign-off, or past them — but content is settled inside the agency now, so
   * one button is left. It sits on the row rather than in the `action` slot
   * because it moves the task somewhere `quickStatus` does not.
   */
  { key: "written", label: "Content ready", status: "pending", contentWritten: true },
  { key: "content", label: "Content review", status: "content_review", action: { label: "Approve content", status: "approved" } },
  { key: "final", label: "Final review", status: "review", action: { label: "Approve", status: "approved" } },
  { key: "changes", label: "Changes requested", status: "changes_requested", action: { label: "Mark resolved", status: "resolved" } },
  { key: "approved", label: "Recently approved", status: "approved", action: { label: "Schedule", status: "scheduled" } },
  // Where the Schedule button above sends things — otherwise a scheduled video
  // left the board entirely and there was nowhere to see what is queued to go
  // out.
  { key: "scheduled", label: "Scheduled", status: "scheduled", action: { label: "Mark posted", status: "posted" } },
  /*
   * And where "Mark posted" sends them.
   *
   * The board ran out one step early: a video was scheduled, marked posted,
   * and vanished — the last tab was a list of things about to go, with no way
   * to see what had gone. Which is the question actually asked at the end of
   * a month.
   *
   * No action on it, deliberately. Posted is the end of the client's journey
   * through this board, and a tab that is only ever read does not need a
   * button to press.
   */
  { key: "posted", label: "Posted", status: "posted", postedEither: true },
];

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; service?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.tab) ?? TABS[0]) as (typeof TABS)[number];
  const service = isServiceKey(sp.service) ? sp.service : null;
  const scopeIds = await crmClientIds(user);
  // Putting something in front of a client, and releasing it past them, are
  // both the super admin's — and their crm's, for their own clients.
  const canSend = user.role === "super_admin" || user.role === "crm";
  const scope = { service: service ?? undefined, crmClientIds: scopeIds };
  const filters = active.postedEither
    ? { postedEither: true, ...scope }
    : active.contentWritten
      ? { contentWritten: true, ...scope }
      : { status: active.status, ...scope };

  const [rows, counts, serviceCounts, waRows, waCounts] = await Promise.all([
    getDeliverables(filters),
    getApprovalCounts(scopeIds),
    getServiceCounts(filters),
    getApprovalBoard(scopeIds),
    getWaApprovalCounts(scopeIds),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CheckCircle2 className="h-6 w-6 text-primary" />
          Approvals
        </h1>
        <p className="text-sm text-muted-foreground">
          Track work through to the client&apos;s approval.
        </p>
      </div>

      {/* Live board for videos sent to clients on WhatsApp. Rendered above the
          internal gates because it is the one that moves without anyone in the
          agency touching it. */}
      <ApprovalBoard
        initialRows={waRows}
        initialCounts={waCounts}
        socketUrl={env.whatsappService.socketUrl || null}
      />

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
                {/* The client and the category restack under the title;
                    what stays is what it is and what to do about it. */}
                <th>Title</th>
                <th className="hidden md:table-cell">Client</th>
                <th className="hidden lg:table-cell">Service &amp; category</th>
                <th className="hidden sm:table-cell">Due</th>
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
                    <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
                      {d.company_name}
                      <span className="sm:hidden"> · due {fmtDate(d.due_date)}</span>
                    </span>
                  </TD>
                  <TD className="hidden md:table-cell">{d.company_name}</TD>
                  <TD className="hidden lg:table-cell">
                    <ServiceBadge task={d} category={d.content_category} />
                  </TD>
                  <TD className="hidden text-muted-foreground sm:table-cell">
                    {fmtDate(d.due_date)}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* One button, where there were two. The other sent the
                          copy to the client for sign-off; content no longer
                          goes to a client at all, so the only way out of this
                          tab is into the hands of whoever makes it. */}
                      {active.contentWritten && canSend ? (
                        <form action={approveContentToTeam}>
                          <input type="hidden" name="deliverable_id" value={d.id} />
                          <Button type="submit" size="sm">
                            Approve — to the team
                          </Button>
                        </form>
                      ) : null}
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
