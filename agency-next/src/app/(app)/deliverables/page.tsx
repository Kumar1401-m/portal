import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import {
  getDeliverables,
  getServiceCounts,
  getAssignees,
} from "@/lib/deliverables";
import { crmClientIds } from "@/lib/crm";
import { getCategoryMap } from "@/lib/categories";
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
import { SearchBox } from "@/components/admin/search-box";
import { Pager } from "@/components/admin/pager";
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

  const [all, counts, assignees, categoryMap] = await Promise.all([
    getDeliverables(filters),
    getServiceCounts(filters),
    getAssignees(),
    getCategoryMap(),
  ]);

  /*
   * Eight to a page, the same as Today's Tasks.
   *
   * The board used to print every row it had. Thirty tasks made a page you
   * scrolled past the window to read, and the heading said "30 tasks" while
   * the screen showed however many happened to fit — so the ones below the
   * fold read as missing rather than further down.
   */
  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  // Clamped, so a hand-edited or stale ?page= lands on a real page instead of
  // an empty table that looks like the work vanished.
  const page = Math.min(Math.max(1, Math.trunc(Number(sp.page)) || 1), totalPages);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
            {/* The real total, not what fits on this page — the heading is
                how you know there is a second page to go to. */}
            {all.length} task{all.length === 1 ? "" : "s"}
            {hasFilters ? " (filtered)" : ""}
          </p>
        </div>
        <Link href={newHref} className={buttonClasses()}>
          <Plus className="h-4 w-4" /> New task
        </Link>
      </div>

      <ServiceTabs basePath="/deliverables" active={service} counts={counts} params={params} />

      <SearchBox basePath="/deliverables" params={params} />

      <Card className="overflow-hidden">
        {all.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No {service ? SERVICES[service].label.toLowerCase() : ""} tasks
            {hasFilters ? " match these filters" : " yet"}.
          </p>
        ) : (
          /* Sized to fit without scrolling sideways — the scrollbar hid the
             right-hand columns, which included the one the board exists for.
             Speciality went because it was the same value on every row of a
             client and sat beside that client's own name; the hook went
             because at column width a paragraph is four words and an
             ellipsis. Caption stayed, clamped to two lines, because whether
             one exists is the question this board gets asked most. */
          <Table dense>
              <THead>
                <tr>
                  <th className="w-10 text-right">#</th>
                  <th>Organization</th>
                  <th>Creative type</th>
                  <th className="whitespace-nowrap">Schedule date</th>
                  <th>Content status</th>
                  <th>Design status</th>
                  <th>Post status</th>
                  <th className="hidden 2xl:table-cell">Caption</th>
                  <th className="text-center">Shoot</th>
                  <th className="text-center">Video</th>
                  <th className="hidden 2xl:table-cell">Remarks</th>
                  <th className="text-right">Actions</th>
                </tr>
              </THead>
              <TBody>
                {rows.map((d, i) => (
                  <TR key={d.id}>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {(page - 1) * PAGE_SIZE + i + 1}
                    </TD>
                    <TD className="max-w-[9rem]">
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
                    <TD>
                      <Badge tone={statusTone(d.status)}>{contentStatusLabel(d.status)}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={postStatusTone(d.status, d.posting_status)}>
                        {postStatusLabel(d.status, d.posting_status)}
                      </Badge>
                    </TD>
                    {/* Two lines rather than one truncated one: a caption is
                        judged on how it opens, and the first line alone is
                        enough to tell whether it has been written yet. The
                        whole thing is on hover. */}
                    <TD className="max-w-[10rem] hidden 2xl:table-cell">
                      {d.caption ? (
                        <span
                          className="line-clamp-2 text-xs text-muted-foreground"
                          title={d.caption}
                        >
                          {d.caption}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    {/* Separate columns, so a glance down each one shows which
                        clients still owe footage and which videos are cut —
                        two different questions, asked of the whole board
                        rather than of one row. */}
                    <TD className="whitespace-nowrap text-center">
                      {d.raw_drive_link ? (
                        <a
                          href={d.raw_drive_link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-center">
                      {d.edited_link || d.cloud_video_link ? (
                        <a
                          href={d.edited_link || d.cloud_video_link!}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="hidden max-w-[8rem] truncate text-muted-foreground 2xl:table-cell" title={d.reject_reason ?? d.writer_notes ?? ""}>
                      {d.reject_reason || d.writer_notes || "—"}
                    </TD>
                    <TD className="text-right">
                      <EditVideoModal
                        deliverable={d}
                        categories={categoryMap}
                        canSendToClient={user.role === "super_admin" || user.role === "crm"}
                        canDelete={user.role === "super_admin"}
                        assignees={assignees}
                        canUploadVideo={user.role !== "crm"}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
        )}
        <Pager
          basePath="/deliverables"
          params={params}
          page={page}
          totalPages={totalPages}
          totalItems={all.length}
          pageSize={PAGE_SIZE}
        />
      </Card>
    </div>
  );
}
