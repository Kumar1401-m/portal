import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Video, GraduationCap, Layers, Plus } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient, crmClientIds } from "@/lib/crm";
import { getDeliverables, getAssignees } from "@/lib/deliverables";
import { getCategoryMap } from "@/lib/categories";
import { queryOne } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { MonthPicker } from "@/components/admin/month-picker";
import { EditVideoModal } from "../../deliverables/edit-video-modal";
import { TaskDate } from "../../deliverables/task-date";
import { SERVICES, serviceOf, isServiceKey } from "@/lib/services";
import {
  contentStatusLabel,
  contentStatusTone,
  editorStatusLabel,
  editorStatusTone,
  posterStageLabel,
  type BadgeTone,
} from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { monthKey } from "@/lib/utils";
import { buildMonthlyReport, renderReportText } from "@/lib/monthly-report";
import { MonthlyReportCard } from "./report-card";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [Number(id)]
  );
  return { title: c ? `${c.company_name} · Reports` : "Reports" };
}

/** dd-mm-yyyy, the way the old report wrote dates. */
function shortDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const CHIPS = [
  { className: "bg-orange-500", Icon: Video },
  { className: "bg-purple-600", Icon: GraduationCap },
  { className: "bg-emerald-600", Icon: Layers },
  { className: "bg-pink-600", Icon: Layers },
  { className: "bg-teal-600", Icon: Layers },
];

/** Promotion type pills, coloured consistently by name. */
const PROMO_COLOURS = [
  "bg-blue-600",
  "bg-purple-600",
  "bg-emerald-600",
  "bg-orange-500",
  "bg-pink-600",
  "bg-teal-600",
];
function promoColour(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PROMO_COLOURS[h % PROMO_COLOURS.length];
}

/**
 * A status, in the portal's own colours.
 *
 * This page used to paint every pill one of two colours: green when the work
 * was finished, amber for everything else. So "Changes requested" — somebody
 * has rejected the work and it has to be done again — looked exactly like
 * "Editing", which is the work going normally. The two states it matters most
 * to tell apart were the two that matched.
 *
 * The tones the rest of the portal uses already draw those distinctions:
 * finished is green, a change request or a rejection is red, work sitting with
 * a person is violet, work being done right now is blue. Using them here means
 * one status has one colour wherever it is shown, rather than a colour per
 * page.
 *
 * Allowed to wrap, still: a nowrap pill cannot shrink below its own text, and
 * a row of those pushed the table wider than the page.
 */
function StatusPill({ text, tone }: { text: string; tone: BadgeTone }) {
  return (
    <Badge tone={tone} className="whitespace-normal text-center">
      {text}
    </Badge>
  );
}

export default async function ClientReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; service?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const clientId = Number(id);
  const month = /^\d{4}-\d{2}$/.test(sp.month || "") ? sp.month! : monthKey();
  // Arriving from the Posters or Videos tab keeps that report's scope.
  const service = isServiceKey(sp.service) ? sp.service : undefined;

  const client = await queryOne<{ id: number; company_name: string }>(
    "SELECT id, company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) notFound();
  if (!(await canAccessClient(user, client.id))) notFound();

  // The same rows the task list uses, so the pencil can open the very same
  // editor rather than a read-only lookalike.
  const scopeIds = await crmClientIds(user);
  const [tasks, assignees, categoryMap, report] = await Promise.all([
    getDeliverables({ clientId: client.id, month, service, crmClientIds: scopeIds }),
    getAssignees(),
    getCategoryMap(),
    // The client-facing write-up of the same month. Never fatal: a report that
    // cannot be built must not take down the task list beside it.
    buildMonthlyReport(client.id, month).catch(() => null),
  ]);

  // Counts per category, in the order they first appear.
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.content_category?.trim() || "Uncategorised";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const posterCount = tasks.filter((t) => serviceOf(t) === "poster_designing").length;
  const videoCount = tasks.length - posterCount;

  return (
    <div className="space-y-4">
      {report ? (
        <MonthlyReportCard
          clientId={client.id}
          month={month}
          monthLabel={report.monthLabel}
          // Exactly what the client will read — which is why it has no link in
          // it: the PDF follows the message into the same group.
          text={renderReportText(report)}
        />
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 bg-indigo-700 px-4 py-3">
          <Link
            href={`/reports?month=${month}${service ? `&service=${service}` : ""}`}
            aria-label="Back to the clients list"
            className="rounded-md p-1 text-white transition-colors hover:bg-white/15"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-semibold text-white">
            {client.company_name}
          </h1>
          {service ? (
            <span className="shrink-0 text-xs text-white/80">{SERVICES[service].label} only</span>
          ) : null}
          {/* Add work for this client without leaving the report — the client
              and the month you're looking at are carried into the form. */}
          <Link
            href={`/deliverables/new?client=${client.id}&month=${month}${
              service ? `&service=${service}` : ""
            }`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/25"
          >
            <Plus className="h-4 w-4" /> New task
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-4">
          <div className="relative rounded border border-border px-3 py-2 text-sm">
            <span className="absolute -top-2 left-2 bg-card px-1 text-[11px] text-muted-foreground">
              Client
            </span>
            <span className="block max-w-56 truncate">{client.company_name}</span>
          </div>
          <MonthPicker
            month={month}
            basePath={`/reports/${client.id}`}
            extra={{ service }}
            label="Select Month and Year"
          />
        </div>

        <div className="px-4 py-4">
          <h2 className="mb-2 text-sm font-semibold">Monthly Deliverables</h2>
          <div className="flex flex-wrap gap-2">
            {[...counts.entries()].map(([name, n], i) => {
              const { className, Icon } = CHIPS[i % CHIPS.length];
              return (
                <span
                  key={name}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-white ${className}`}
                >
                  <Icon className="h-4 w-4" />
                  {name}: {n}
                </span>
              );
            })}
            {/* "Total Videos" counted the posters as videos. It is two
                numbers or one, depending on what this client actually buys. */}
            <span className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-1.5 text-sm font-medium text-white">
              <Layers className="h-4 w-4" />
              {posterCount > 0 && videoCount > 0
                ? `${videoCount} video${videoCount === 1 ? "" : "s"} · ${posterCount} poster${posterCount === 1 ? "" : "s"}`
                : `Total: ${tasks.length}`}
            </span>
          </div>

        </div>

        {/* Percentages of a table-fixed layout, so thirteen columns fit the
            container exactly instead of overflowing it. Title, description and
            remarks give up the slack — they're the ones with room to spare. */}
        <div className="w-full">
          <table className="w-full table-fixed text-sm">
            <thead className="border-y border-border bg-muted/40">
              <tr className="[&_th]:px-2 [&_th]:py-3 [&_th]:align-top [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:leading-snug [&_th]:text-primary">
                {/*
                  Eleven columns, not thirteen.

                  Shoot Link, Editor Link and Thumbnail were three columns that
                  said "—" on most rows and all three of them on every poster —
                  nobody films a poster, so a Shoot Link column against one is
                  a question with no answer. They are one Files column now, and
                  it shows only what that row actually has.
                */}
                <th style={{ width: "3%" }} className="hidden sm:table-cell">
                  S.No
                </th>
                <th style={{ width: "9%" }}>Type</th>
                <th style={{ width: "8%" }} className="hidden sm:table-cell">
                  Date
                </th>
                <th style={{ width: "18%" }}>Title</th>
                <th style={{ width: "7%" }} className="hidden xl:table-cell">
                  Promotion
                </th>
                {/*
                  Two columns, one word each.

                  Merging them into "Files" saved a column and cost the thing
                  the column is for: whether the footage has come in is a
                  different question from whether the edit is done, and they
                  get asked by different people on different days. So they are
                  separate again — the poster rows simply have nothing under
                  Shoot, because nobody films a poster.
                */}
                <th style={{ width: "5%" }} className="hidden md:table-cell">
                  Shoot
                </th>
                <th style={{ width: "6%" }} className="hidden md:table-cell">
                  Edited
                </th>
                <th style={{ width: "10%" }} className="hidden lg:table-cell">
                  Brief
                </th>
                <th style={{ width: "11%" }} className="hidden md:table-cell">
                  Content status
                </th>
                <th style={{ width: "12%" }}>Stage</th>
                <th style={{ width: "7%" }} className="hidden lg:table-cell">
                  Remarks
                </th>
                <th style={{ width: "4%" }} className="text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-2 py-10 text-center text-muted-foreground">
                    No tasks for {client.company_name} this month. Anything you create for them
                    shows up here.
                  </td>
                </tr>
              ) : (
                tasks.map((t, i) => {
                  const svc = SERVICES[serviceOf(t)];
                  // A poster is not filmed and not edited, so it is not
                  // described in those words anywhere on this row.
                  const isPoster = serviceOf(t) === "poster_designing";
                  return (
                    <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="hidden px-2 py-3 align-top text-muted-foreground sm:table-cell">
                        {i + 1}
                      </td>
                      <td className="px-2 py-3 align-top">{t.content_category || svc.short}</td>
                      <td className="hidden px-2 py-3 align-top sm:table-cell">
                        {shortDate(t.scheduled_at || t.due_date)}
                      </td>
                      <td className="px-2 py-3 align-top">
                        <Link
                          href={`/deliverables/${t.id}`}
                          className="hover:text-primary hover:underline"
                        >
                          {t.title}
                        </Link>
                        {/* What the narrow screens folded away, restacked. */}
                        <span className="mt-0.5 block text-xs text-muted-foreground sm:hidden">
                          {shortDate(t.scheduled_at || t.due_date)}
                        </span>
                      </td>
                      <td className="hidden px-2 py-3 align-top xl:table-cell">
                        {t.promotion_type ? (
                          <span
                            className={`inline-block rounded px-2 py-1 text-xs font-medium text-white ${promoColour(
                              t.promotion_type
                            )}`}
                          >
                            {t.promotion_type}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      {/*
                        The footage. A poster has none and never will, so the
                        cell says so rather than offering a link that cannot
                        exist — this column asked every poster for a shoot.
                      */}
                      <td className="hidden px-2 py-3 align-top md:table-cell">
                        {isPoster ? (
                          <span className="text-xs text-muted-foreground">n/a</span>
                        ) : t.raw_drive_link ? (
                          <a
                            href={t.raw_drive_link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 underline"
                          >
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      {/* The finished thing: the cut for a video, the artwork
                          for a poster. Both arrive in the same column, so the
                          thumbnail sits with it rather than in a column of its
                          own that was empty on most rows. */}
                      <td className="hidden px-2 py-3 align-top md:table-cell">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {t.edited_link ? (
                            <a
                              href={t.edited_link}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 underline"
                            >
                              View
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {t.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={t.thumbnail_url}
                              alt=""
                              className="h-8 w-12 rounded object-cover"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td
                        className="hidden px-2 py-3 align-top text-muted-foreground lg:table-cell"
                        title={t.description ?? ""}
                      >
                        {/* Truncation goes on an inner block, not the cell —
                            a table cell doesn't clip its overflow reliably,
                            and the few pixels that escaped were enough to put
                            a scrollbar under the table. */}
                        <span className="block truncate">{t.description || "—"}</span>
                      </td>
                      <td className="hidden px-2 py-3 align-top md:table-cell">
                        <StatusPill
                          text={contentStatusLabel(t.status)}
                          tone={contentStatusTone(t.status)}
                        />
                      </td>
                      {/* The stage, in the words of the work it describes: a
                          poster handed to its designer read "Awaiting raw"
                          before this, which is raw footage nobody is shooting. */}
                      <td className="px-2 py-3 align-top">
                        <StatusPill
                          text={isPoster ? posterStageLabel(t.status) : editorStatusLabel(t.status)}
                          tone={editorStatusTone(t.status)}
                        />
                      </td>
                      <td
                        className="hidden px-2 py-3 align-top text-muted-foreground lg:table-cell"
                        title={t.reject_reason ?? ""}
                      >
                        <span className="block truncate">{t.reject_reason || "—"}</span>
                      </td>
                      <td className="px-2 py-3 text-right align-top">
                        {/* The same editor as the task list — one dialog for
                            editing a task, wherever you reach it from. */}
                        <div className="flex items-center justify-end gap-1">
                          {/* The date, beside the pencil that opens everything else. Moving a
                              task a day used to mean opening the client and finding its month. */}
                          <TaskDate taskId={t.id} title={t.title} dueDate={t.due_date} />
                          <EditVideoModal
                            deliverable={t}
                            categories={categoryMap}
                            canSendToClient={user.role === "super_admin" || user.role === "crm"}
                            canDelete={user.role === "super_admin"}
                            assignees={assignees}
                            canUploadVideo={user.role !== "crm"}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
