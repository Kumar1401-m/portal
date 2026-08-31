import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getDeliverables, getAssignees } from "@/lib/deliverables";
import type { ServiceCounts } from "@/lib/deliverables";
import { crmClientIds } from "@/lib/crm";
import { getCategoryMap } from "@/lib/categories";
import { parseTaskQuery, type SearchParams } from "@/lib/task-query";
import { SERVICES, SERVICE_KEYS, serviceOf } from "@/lib/services";
import {
  contentStageLabel,
  contentStageTone,
  isFinished,
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
import { EditVideoModal } from "./edit-video-modal";
import { TaskDate } from "./task-date";
import { Badge } from "@/components/ui/badge";
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

  const [board, assignees, categoryMap] = await Promise.all([
    getDeliverables(filters),
    getAssignees(),
    getCategoryMap(),
  ]);

  /*
   * Finished work is not on the working board either.
   *
   * It was, and it accumulated: this board is what the agency is doing, and a
   * post that went out in May is not that. Every month added rows that would
   * never move again, until the things still needing attention were a
   * minority of their own list.
   *
   * Not deleted, though — "posted" is a fair thing to want to look up, and
   * cancelled and rejected live nowhere else. So they are one click away
   * rather than gone, behind a link rather than a filter bar: the filters
   * came off this board on purpose and are not going back on for this.
   */
  const showDone = sp.done === "1";
  const all = showDone ? board : board.filter((d) => !isFinished(d.status, d.posting_status));
  const doneCount = board.length - all.length;

  // Counted from the rows on screen. Counting the hidden ones would put 28
  // above a board holding 12 — the discrepancy this change would otherwise
  // have introduced.
  const counts = { all: all.length } as ServiceCounts;
  for (const k of SERVICE_KEYS) counts[k] = 0;
  for (const d of all) counts[serviceOf(d)]++;

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
  /** The same board with the finished rows switched on or off. */
  const doneHref = (on: boolean) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, String(v));
    if (service) qs.set("service", service);
    if (on) qs.set("done", "1");
    const q = qs.toString();
    return q ? `/deliverables?${q}` : "/deliverables";
  };
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
            {showDone ? (
              <>
                {" · including finished · "}
                <Link href={doneHref(false)} className="text-primary hover:underline">
                  hide them
                </Link>
              </>
            ) : doneCount > 0 ? (
              <>
                {` · ${doneCount} finished, hidden · `}
                <Link href={doneHref(true)} className="text-primary hover:underline">
                  show
                </Link>
              </>
            ) : null}
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
                  {/*
                    What a phone keeps.

                    `table-fixed` shares the width between whatever columns are
                    showing, so seven of them on a 390px screen is fifty pixels
                    each and a client called "4insitestudio" renders as "4in…".
                    The narrow, repeatable columns therefore fold away first and
                    what they said is restacked under the name in the cell below,
                    so a phone loses the grid and never the facts.
                  */}
                  <th className="hidden w-10 text-right sm:table-cell">#</th>
                  <th>Client name</th>
                  <th className="hidden w-28 md:table-cell">Schedule date</th>
                  <th className="hidden w-32 lg:table-cell">Content status</th>
                  <th className="hidden w-32 md:table-cell">Design status</th>
                  <th className="w-28">Post status</th>
                  <th className="hidden w-32 2xl:table-cell">Caption</th>
                  <th className="hidden w-20 text-center xl:table-cell">Shoot</th>
                  <th className="hidden w-20 text-center xl:table-cell">Video</th>
                  <th className="hidden w-28 2xl:table-cell">Remarks</th>
                  <th className="w-24 text-right">Actions</th>
                </tr>
              </THead>
              <TBody>
                {rows.map((d, i) => (
                  <TR key={d.id}>
                    <TD className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                      {(page - 1) * PAGE_SIZE + i + 1}
                    </TD>
                    <TD>
                      <Link
                        href={`/deliverables/${d.id}`}
                        className="font-medium text-foreground transition-colors hover:text-primary hover:underline"
                      >
                        {d.company_name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{d.title}</div>
                      {/* What the folded columns were carrying, restacked under
                          the name and shown only while they are folded. */}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 md:hidden">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {fmtDate(d.scheduled_at ?? d.due_date)}
                        </span>
                        <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                        <span className="lg:hidden">
                          <Badge tone={contentStageTone(d.status)}>{contentStageLabel(d.status)}</Badge>
                        </span>
                      </div>
                    </TD>
                    {/* The scheduled slot when there is one; the due date is
                        what we aim at, the schedule is what actually happens. */}
                    <TD className="hidden whitespace-nowrap tabular-nums text-muted-foreground md:table-cell">
                      {fmtDate(d.scheduled_at ?? d.due_date)}
                    </TD>
                    <TD className="hidden lg:table-cell">
                      <Badge tone={contentStageTone(d.status)}>{contentStageLabel(d.status)}</Badge>
                    </TD>
                    <TD className="hidden md:table-cell">
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
                    <TD className="hidden whitespace-nowrap text-center xl:table-cell">
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
                    <TD className="hidden whitespace-nowrap text-center xl:table-cell">
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
                      <div className="flex items-center justify-end gap-1">
                        {/* The date, beside the pencil that opens everything else. Moving a
                            task a day used to mean opening the client and finding its month. */}
                        <TaskDate taskId={d.id} title={d.title} dueDate={d.due_date} />
                        <EditVideoModal
                          deliverable={d}
                          categories={categoryMap}
                          canSendToClient={user.role === "super_admin" || user.role === "crm"}
                          canDelete={user.role === "super_admin"}
                          assignees={assignees}
                          canUploadVideo={user.role !== "crm"}
                        />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
        )}
        {/* Paging must not silently switch the finished rows back off — every
            other filter travels in the link, and this one does too. */}
        <Pager
          basePath="/deliverables"
          params={showDone ? { ...params, done: "1" } : params}
          page={page}
          totalPages={totalPages}
          totalItems={all.length}
          pageSize={PAGE_SIZE}
        />
      </Card>
    </div>
  );
}
