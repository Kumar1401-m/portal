import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import {
  getDeliverables,
  getServiceCounts,
  getClientsMini,
  getAssignees,
} from "@/lib/deliverables";
import { crmClientIds } from "@/lib/crm";
import { getCategoryMap, getUsedCategories } from "@/lib/categories";
import { parseTaskQuery, type SearchParams } from "@/lib/task-query";
import { SERVICES } from "@/lib/services";
import {
  contentStatusLabel,
  editorStatusLabel,
  editorStatusTone,
} from "@/lib/constants";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { ServiceTabs } from "@/components/admin/service-tabs";
import { TaskFilters } from "@/components/admin/task-filters";
import { ServiceBadge } from "@/components/ui/service-badge";
import { EditVideoModal } from "../deliverables/edit-video-modal";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "Today's Tasks · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser(STAFF_ROLES);
  const isDesigner = user.role === "poster_designer";
  const sp = await searchParams;
  const { params, service, filters, hasFilters } = parseTaskQuery(sp);
  const scopeIds = await crmClientIds(user);

  // Designers only ever see their own worklist; crm only their assigned
  // clients; admins/super_admins see everyone's.
  const scoped = {
    ...filters,
    today: true,
    assignedTo: isDesigner ? user.id : filters.assignedTo,
    crmClientIds: scopeIds,
  };

  const [rows, counts, clients, assignees, categoryMap, usedCategories] = await Promise.all([
    getDeliverables(scoped),
    getServiceCounts(scoped),
    getClientsMini(scopeIds),
    getAssignees(),
    getCategoryMap(),
    getUsedCategories(),
  ]);

  const categories = service
    ? Array.from(new Set([...categoryMap[service].map((c) => c.name), ...usedCategories]))
    : usedCategories;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CalendarCheck className="h-6 w-6 text-primary" />
          {isDesigner ? "Your Tasks — Today & Overdue" : "Today's Tasks"}
          {service ? (
            <span className="text-muted-foreground">· {SERVICES[service].label}</span>
          ) : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} item{rows.length === 1 ? "" : "s"} due today or overdue
          {hasFilters ? " (filtered)" : ""}.
        </p>
      </div>

      <ServiceTabs basePath="/today" active={service} counts={counts} params={params} />

      <TaskFilters
        basePath="/today"
        params={params}
        categories={categories}
        clients={clients}
        assignees={assignees}
        showSearch={false}
        showMonth={false}
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            Nothing due{hasFilters || service ? " in this view" : ""} — you&apos;re all caught up. 🎉
          </p>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Client</th>
                <th>Service &amp; category</th>
                <th className="text-center">Shoot</th>
                <th className="text-center">Editor</th>
                <th>Content status</th>
                <th>Editor status</th>
                {!isDesigner ? <th>Assigned to</th> : null}
                <th>Due</th>
                <th>Remarks</th>
                <th className="text-right">Edit</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((d) => {
                const overdue = d.due_date
                  ? new Date(d.due_date) < new Date(new Date().toDateString())
                  : false;
                return (
                  <TR key={d.id}>
                    <TD className="max-w-[16rem]">
                      <Link href={`/deliverables/${d.id}`} className="font-medium hover:text-primary hover:underline">
                        {d.company_name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{d.title}</div>
                    </TD>
                    <TD>
                      <ServiceBadge task={d} category={d.content_category} />
                    </TD>
                    <TD className="text-center">
                      {d.raw_drive_link ? (
                        <a href={d.raw_drive_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">View</a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="text-center">
                      {d.edited_link ? (
                        <a href={d.edited_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">View</a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(d.status)}>{contentStatusLabel(d.status)}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                    </TD>
                    {!isDesigner ? (
                      <TD className="whitespace-nowrap text-muted-foreground">{d.assignee_name || "—"}</TD>
                    ) : null}
                    <TD className="whitespace-nowrap">
                      <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {fmtDate(d.due_date)}
                      </span>
                    </TD>
                    <TD className="max-w-[12rem] truncate text-muted-foreground" title={d.reject_reason ?? ""}>
                      {d.reject_reason || "—"}
                    </TD>
                    <TD className="text-right">
                      <EditVideoModal
                        deliverable={d}
                        categories={categoryMap}
                        canSendToClient={user.role === "super_admin" || user.role === "crm"}
                      />
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
