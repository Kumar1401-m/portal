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
  postStatusLabel,
  postStatusTone,
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
import { POST_COUNTRIES, utcToLocalInput } from "@/lib/zapier";

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
        <Link href={newHref} className={buttonClasses()}>
          <Plus className="h-4 w-4" /> New task
        </Link>
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
          /* Column order follows the board this replaces: who it is for, what
             it is, when it goes out, then the two work tracks, then where it
             stands with Instagram. Wide on purpose — it scrolls sideways
             inside the card rather than dropping columns, because the whole
             point is seeing a row end to end. */
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <th className="w-10 text-right">#</th>
                  <th>Organization</th>
                  <th>Creative type</th>
                  <th className="whitespace-nowrap">Schedule date</th>
                  <th>Speciality</th>
                  <th>Content in post</th>
                  <th>Caption</th>
                  <th>Content status</th>
                  <th className="text-center">Shoot</th>
                  <th className="text-center">Design link</th>
                  <th>Design status</th>
                  <th>Remarks</th>
                  <th>Designer</th>
                  <th>Post status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </THead>
              <TBody>
                {rows.map((d, i) => (
                  <TR key={d.id}>
                    <TD className="text-right tabular-nums text-muted-foreground">{i + 1}</TD>
                    <TD className="max-w-[12rem]">
                      <Link
                        href={`/deliverables/${d.id}`}
                        className="font-medium text-foreground transition-colors hover:text-primary hover:underline"
                      >
                        {d.company_name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{d.title}</div>
                    </TD>
                    <TD>
                      <ServiceBadge task={d} category={d.content_category} />
                    </TD>
                    {/* The scheduled slot when there is one; the due date is
                        what we aim at, the schedule is what actually happens. */}
                    <TD className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {fmtDate(d.scheduled_at ?? d.due_date)}
                    </TD>
                    <TD className="max-w-[9rem] truncate text-muted-foreground">
                      {d.business_type || "—"}
                    </TD>
                    <TD className="max-w-[11rem] truncate text-muted-foreground" title={d.content_hook ?? ""}>
                      {d.content_hook || "—"}
                    </TD>
                    <TD className="max-w-[11rem] truncate text-muted-foreground" title={d.caption ?? ""}>
                      {d.caption || "—"}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(d.status)}>{contentStatusLabel(d.status)}</Badge>
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
                      <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                    </TD>
                    <TD className="max-w-[11rem] truncate text-muted-foreground" title={d.reject_reason ?? d.writer_notes ?? ""}>
                      {d.reject_reason || d.writer_notes || "—"}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {d.assignee_name || "—"}
                    </TD>
                    <TD>
                      <Badge tone={postStatusTone(d.status, d.posting_status)}>
                        {postStatusLabel(d.status, d.posting_status)}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <EditVideoModal
                        deliverable={d}
                        categories={categoryMap}
                        canSendToClient={user.role === "super_admin" || user.role === "crm"}
                        canDelete={user.role === "super_admin"}
                        assignees={assignees}
                        canUploadVideo={user.role !== "crm"}
                        postCountries={user.role === "super_admin" ? POST_COUNTRIES : []}
                        postCountry={POST_COUNTRIES[0].key}
                        scheduledAtLocal={utcToLocalInput(d.scheduled_at, POST_COUNTRIES[0].key)}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
