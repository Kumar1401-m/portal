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
   * Finished work leaves it. A video went out and its row stayed, so the board
   * grew by every piece the agency had ever finished until the things needing
   * attention were a minority of their own list. A posted piece is waiting on
   * nobody and lives on Approvals → Posted.
   */
  /*
   * `pending` used to be left off this board, and must not be any more.
   *
   * The reasoning was sound while it lasted: a pending task is a brief nobody
   * has written, that belonged on the content desk, and putting a month of
   * them here buried the work actually in flight. Only one exception got
   * through — a slot whose footage had already arrived, because somebody
   * outside the agency had acted and it was waiting on us.
   *
   * The content desk is gone. So every one of those tasks now had nowhere at
   * all to be seen: hidden here, and no desk to be hidden in favour of. A
   * month generated on the 1st showed an empty day board.
   */
  const all = board.filter((d) => !isFinished(d.status, d.posting_status));

  /*
   * Written and waiting to be released, which is not the same as pending.
   *
   * The count has to match the tab it links to. Approvals → Content ready is
   * `pending` with something actually written in it; counting bare `pending`
   * here would promise a number of rows that tab does not hold.
   */
  const written = board.filter(
    (d) => d.status === "pending" && Boolean((d.description ?? "").trim())
  ).length;

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
   * Copy written and waiting to be released.
   *
   * Said at the top rather than left to a column, because it is the state
   * nobody owns: it is finished, it is not moving, and it can sit for a week
   * without anyone noticing. The link goes to Approvals, where it is released.
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
      {withClient > 0 || (written > 0 && !isDesigner) ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Content:</span>
          {withClient > 0 ? (
            <Link
              href={statusHref("content_review")}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-3 py-1 font-medium text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--warning)_20%,transparent)]"
            >
              <Hourglass className="h-3.5 w-3.5" />
              {withClient} in content review
            </Link>
          ) : null}
          {written > 0 && !isDesigner ? (
            <Link
              href="/approvals?tab=written"
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-muted-foreground transition-colors hover:bg-muted"
            >
              <PenLine className="h-3.5 w-3.5" />
              {written} written, not handed over yet
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
                {/* Raw footage and the cut video are the video track's, and a
                    poster designer has neither — the two columns were a dash
                    on every row of their board, spending width to say nothing
                    twice. */}
                {isDesigner ? null : (
                  <>
                    <th className="hidden w-20 text-center xl:table-cell">Shoot</th>
                    <th className="hidden w-20 text-center xl:table-cell">Video</th>
                  </>
                )}
                <th className="hidden w-28 2xl:table-cell">Remarks</th>
                <th className="w-20 text-right">Actions</th>
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
                      {/* What the folded columns were carrying, restacked
                          under the name and shown only while they are folded.
                          A phone loses the grid; it must not lose the date the
                          task is due on. */}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 md:hidden">
                        <span
                          className={`text-xs tabular-nums ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                        >
                          {fmtDate(d.scheduled_at ?? d.due_date)}
                        </span>
                        <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
                        <span className="lg:hidden">
                          <Badge tone={contentStageTone(d.status)}>{contentStageLabel(d.status)}</Badge>
                        </span>
                      </div>
                    </TD>
                    <TD className="hidden whitespace-nowrap tabular-nums md:table-cell">
                      <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {fmtDate(d.scheduled_at ?? d.due_date)}
                      </span>
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
                        <TD className="hidden whitespace-nowrap text-center xl:table-cell">
                          {d.raw_drive_link ? (
                            <a href={d.raw_drive_link} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View</a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TD>
                        <TD className="hidden whitespace-nowrap text-center xl:table-cell">
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
