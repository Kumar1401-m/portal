import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import {
  getDeliverables,
  getClientsMini,
  getServiceCounts,
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
import { buttonClasses } from "@/components/ui/button";
import { ServiceTabs } from "@/components/admin/service-tabs";
import { TaskFilters } from "@/components/admin/task-filters";
import { ServiceBadge } from "@/components/ui/service-badge";
import { EditVideoModal } from "./edit-video-modal";
import { Badge, statusTone } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "Tasks · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function DeliverablesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const { params, service, filters: parsedFilters, hasFilters } = parseTaskQuery(sp);
  const scopeIds = await crmClientIds(user);
  const filters = { ...parsedFilters, crmClientIds: scopeIds };

  const [rows, counts, clients, assignees, categoryMap, usedCategories] = await Promise.all([
    getDeliverables(filters),
    getServiceCounts(filters),
    getClientsMini(scopeIds),
    getAssignees(),
    getCategoryMap(),
    getUsedCategories(),
  ]);

  // Inside a service tab the category list is that service's own; on "All
  // tasks" fall back to every category actually in use.
  const categories = service
    ? Array.from(new Set([...categoryMap[service].map((c) => c.name), ...usedCategories]))
    : usedCategories;

  const heading = service ? SERVICES[service].label : "All Tasks";
  const newHref = service ? `/deliverables/new?service=${service}` : "/deliverables/new";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ClipboardList className="h-6 w-6 text-primary" />
            {heading}
          </h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} task{rows.length === 1 ? "" : "s"}
            {hasFilters ? " (filtered)" : ""}
          </p>
        </div>
        {user.role !== "crm" ? (
          <Link href={newHref} className={buttonClasses()}>
            <Plus className="h-4 w-4" /> New task
          </Link>
        ) : null}
      </div>

      <ServiceTabs basePath="/deliverables" active={service} counts={counts} params={params} />

      <TaskFilters
        basePath="/deliverables"
        params={params}
        categories={categories}
        clients={clients}
        assignees={assignees}
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No {service ? SERVICES[service].label.toLowerCase() : ""} tasks
            {hasFilters ? " match these filters" : " yet"}.
          </p>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Title</th>
                <th>Service &amp; category</th>
                <th className="text-center">Shoot</th>
                <th className="text-center">Editor</th>
                <th>Content status</th>
                <th>Editor status</th>
                <th>Assigned to</th>
                <th>Due</th>
                <th>Remarks</th>
                <th className="text-right">Edit</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((d) => (
                <TR key={d.id}>
                  <TD className="max-w-[16rem]">
                    <Link
                      href={`/deliverables/${d.id}`}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {d.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">{d.company_name}</div>
                  </TD>
                  <TD>
                    <ServiceBadge task={d} category={d.content_category} />
                  </TD>
                  <TD className="text-center">
                    {d.raw_drive_link ? (
                      <a href={d.raw_drive_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        View
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD className="text-center">
                    {d.edited_link ? (
                      <a href={d.edited_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        View
                      </a>
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
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {d.assignee_name || "—"}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{fmtDate(d.due_date)}</TD>
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
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
