import Link from "next/link";
import { CalendarCheck, CalendarClock, Hourglass, PenLine } from "lucide-react";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { getDeliverables, getAssignees, boardEmptyReason } from "@/lib/deliverables";
import type { ServiceCounts } from "@/lib/deliverables";
import { EmptyBoard } from "@/components/admin/empty-board";
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
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { ServiceTabs } from "@/components/admin/service-tabs";
import { SearchBox } from "@/components/admin/search-box";
import { Pager } from "@/components/admin/pager";
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
  /*
   * Not the editor's screen any more.
   *
   * This board is every client's work, and an editor reaching it — by an old
   * link or a typed URL — got the whole agency's rather than their own. My
   * work is the answer to the question they were asking, so that is where the
   * guard sends them.
   */
  const user = await requireUser(STAFF_ROLES.filter((r) => r !== "video_editor"));
  const isDesigner = user.role === "poster_designer";
  const sp = await searchParams;
  const { params, service, filters, hasFilters } = parseTaskQuery(sp);
  const scopeIds = await crmClientIds(user);

  /*
   * Every task, not only today's.
   *
   * It was filtered to "due today or overdue", so a day with one thing due
   * showed one row while the month held thirty — and the thirty were only
   * findable on another board. This is the board people actually work from,
   * so it holds the work: everything, ordered so that what is still to do
   * comes before what is finished and the oldest date is first. Page one is
   * therefore still the day's work, and the rest is one click away rather
   * than one screen away.
   *
   * Designers only ever see their own worklist; crm only their assigned
   * clients; admins/super_admins see everyone's.
   */
  const scoped = {
    ...filters,
    openFirst: true,
    assignedTo: isDesigner ? user.id : filters.assignedTo,
    crmClientIds: scopeIds,
  };

  const [board, assignees, categoryMap] = await Promise.all([
    getDeliverables(scoped),
    getAssignees(),
    getCategoryMap(),
  ]);

  /*
   * This board is work that still needs doing, and only that.
   *
   * It fills from both ends. A month is created as thirty tasks at once, all
   * `pending` and none of them workable — thirty rows of "yet to start" that
   * the four late ones hid behind. Writing those is a real job with its own
   * screen now. And nothing ever left at the other end either: a video went
   * out and its row stayed, so the board grew by every piece the agency had
   * ever finished.
   *
   * Both ends go. What is left is what is moving — with the client, being
   * made, waiting to go out.
   *
   * Content sent to the client stays: that is the one content state waiting
   * on somebody, which is exactly what this board is for. A posted piece is
   * waiting on nobody, and lives on Approvals → Posted.
   */
  const all = board.filter(
    (d) => d.status !== "pending" && !isFinished(d.status, d.posting_status)
  );
  const onContentDesk = board.filter((d) => d.status === "pending").length;

  /*
   * The tab counts are counted from the same rows the table shows.
   *
   * `getServiceCounts` counts what the filters select, which now includes the
   * briefs this board deliberately leaves out — a tab reading 34 above a board
   * holding 4 is a bug report waiting to happen.
   */
  const counts = { all: all.length } as ServiceCounts;
  for (const k of SERVICE_KEYS) counts[k] = 0;
  for (const d of all) counts[serviceOf(d)]++;

  // How much of it is actually due — the number the heading used to be about,
  // and still worth saying now that the board holds more than that. Nothing
  // finished is in `all` any more, so the date is the only test left.
  const today = new Date(new Date().toDateString());
  const dueNow = all.filter((d) => d.due_date && new Date(d.due_date) <= today).length;

  /*
   * Content that has gone out and is waiting on an answer.
   *
   * Said at the top rather than left to a column, because it is the state
   * nobody owns: the work is not ours and not moving, and a piece can sit
   * there for a week without anyone noticing. The link is into the content
   * desk, where the answer is recorded.
   *
   * A designer's board is their own posters and never carries this — content
   * is not their job and the count would be nought.
   */
  const withClient = isDesigner ? 0 : all.filter((d) => d.status === "content_review").length;
  const statusHref = (s: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (k !== "status" && v) qs.set(k, String(v));
    if (service) qs.set("service", service);
    qs.set("status", s);
    return `/today?${qs.toString()}`;
  };

  // Eight to a page. A day's work should be readable without scrolling, and a
  // list long enough to scroll is one you skim rather than work through.
  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  // Clamped, so a hand-edited or stale ?page= lands on a real page instead of
  // an empty table that looks like the work vanished.
  const page = Math.min(Math.max(1, Math.trunc(Number(sp.page)) || 1), totalPages);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
          {all.length} task{all.length === 1 ? "" : "s"}
          {dueNow > 0 ? ` · ${dueNow} due today or overdue, first` : " · nothing due today"}
          {hasFilters ? " (filtered)" : ""}.
        </p>
      </div>

      <ServiceTabs basePath="/today" active={service} counts={counts} params={params} />

      <SearchBox basePath="/today" params={params} />

      {/* The content strip, above the table rather than inside a column of it.
          Only shown when there is something in it — a strip that always reads
          "0" is a strip people stop seeing. */}
      {withClient > 0 || (onContentDesk > 0 && !isDesigner) ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Content:</span>
          {withClient > 0 ? (
            <Link
              href={statusHref("content_review")}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-3 py-1 font-medium text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--warning)_20%,transparent)]"
            >
              <Hourglass className="h-3.5 w-3.5" />
              {withClient} waiting on client approval
            </Link>
          ) : null}
          {onContentDesk > 0 && !isDesigner ? (
            <Link
              href="/content"
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-muted-foreground transition-colors hover:bg-muted"
            >
              <PenLine className="h-3.5 w-3.5" />
              {onContentDesk} not sent to the client yet
            </Link>
          ) : null}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyBoard
            reason={await boardEmptyReason(scopeIds)}
            filtered={hasFilters || Boolean(service)}
          />
        ) : (
          <>
            {/* Said once, above the rows, so nobody reads a list that runs on
                into next week as a list of things that are late. */}
            {dueNow === 0 ? (
              <p className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                Nothing is due today — none of these is late.
              </p>
            ) : null}
          {/* Same columns, same order as the Tasks board. Two boards that show
              the same rows should not need reading twice. The one difference
              is the date, which is emphasised when it has passed — that is
              what this board is for. */}
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
                {/* Raw footage and the cut video are the video track's, and a
                    poster designer has neither — the two columns were a dash
                    on every row of their board, spending width to say nothing
                    twice. */}
                {isDesigner ? null : (
                  <>
                    <th className="text-center">Shoot</th>
                    <th className="text-center">Video</th>
                  </>
                )}
                <th className="hidden 2xl:table-cell">Remarks</th>
                <th className="text-right">Actions</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((d, i) => {
                const overdue = d.due_date
                  ? new Date(d.due_date) < new Date(new Date().toDateString())
                  : false;
                return (
                  <TR key={d.id}>
                    {/* Numbering runs on across pages, so row 9 is the ninth
                        task and not the first of page two. */}
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
                    <TD className="whitespace-nowrap tabular-nums">
                      <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {fmtDate(d.scheduled_at ?? d.due_date)}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={contentStageTone(d.status)}>{contentStageLabel(d.status)}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={postStatusTone(d.status, d.posting_status)}>
                        {postStatusLabel(d.status, d.posting_status)}
                      </Badge>
                    </TD>
                    <TD className="max-w-[10rem] hidden 2xl:table-cell">
                      {d.caption ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground" title={d.caption}>
                          {d.caption}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    {isDesigner ? null : (
                      <>
                        <TD className="whitespace-nowrap text-center">
                          {d.raw_drive_link ? (
                            <a href={d.raw_drive_link} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View</a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-center">
                          {d.edited_link || d.cloud_video_link ? (
                            <a href={d.edited_link || d.cloud_video_link!} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View</a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TD>
                      </>
                    )}
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
                );
              })}
            </TBody>
          </Table>
          <Pager
            basePath="/today"
            params={params}
            page={page}
            totalPages={totalPages}
            totalItems={all.length}
            pageSize={PAGE_SIZE}
          />
          </>
        )}
      </Card>
    </div>
  );
}
