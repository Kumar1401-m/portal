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
import { SERVICES, serviceOf, isServiceKey } from "@/lib/services";
import { contentStatusLabel, editorStatusLabel } from "@/lib/constants";
import { POST_COUNTRIES, utcToLocalInput } from "@/lib/zapier";
import { monthKey } from "@/lib/utils";

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
 * Green when the stage is done, amber while it's in flight.
 *
 * Deliberately allowed to wrap: a nowrap pill can't shrink below its text, and
 * thirteen of those between them pushed the table wider than the page.
 */
function StatusPill({ text, done }: { text: string; done: boolean }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-1 text-center text-xs font-medium text-white ${
        done ? "bg-green-600" : "bg-amber-500"
      }`}
    >
      {text}
    </span>
  );
}

const DONE_STATUSES = ["approved", "scheduled", "posted", "completed"];

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
  const [tasks, assignees, categoryMap] = await Promise.all([
    getDeliverables({ clientId: client.id, month, service, crmClientIds: scopeIds }),
    getAssignees(),
    getCategoryMap(),
  ]);

  // Counts per category, in the order they first appear.
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.content_category?.trim() || "Uncategorised";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return (
    <div className="space-y-4">
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
            <span className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-1.5 text-sm font-medium text-white">
              <Layers className="h-4 w-4" />
              Total Videos: {tasks.length}
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
                <th style={{ width: "3%" }}>S.No</th>
                <th style={{ width: "9%" }}>Creative Type</th>
                <th style={{ width: "8%" }}>Post schedule date</th>
                <th style={{ width: "9%" }}>Promotion Type</th>
                <th style={{ width: "5%" }}>Shoot Link</th>
                <th style={{ width: "5%" }}>Editor Link</th>
                <th style={{ width: "6%" }}>Thumbnail</th>
                <th style={{ width: "15%" }}>Title</th>
                <th style={{ width: "10%" }}>Description</th>
                <th style={{ width: "9%" }}>Content Status</th>
                <th style={{ width: "9%" }}>Editor Status</th>
                <th style={{ width: "8%" }}>Remarks</th>
                <th style={{ width: "4%" }} className="text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-2 py-10 text-center text-muted-foreground">
                    No tasks for {client.company_name} this month. Anything you create for them
                    shows up here.
                  </td>
                </tr>
              ) : (
                tasks.map((t, i) => {
                  const svc = SERVICES[serviceOf(t)];
                  const done = DONE_STATUSES.includes(t.status);
                  return (
                    <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-2 py-3 align-top text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-3 align-top">{t.content_category || svc.short}</td>
                      <td className="px-2 py-3 align-top">
                        {shortDate(t.scheduled_at || t.due_date)}
                      </td>
                      <td className="px-2 py-3 align-top">
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
                      <td className="px-2 py-3 align-top">
                        {t.raw_drive_link ? (
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
                      <td className="px-2 py-3 align-top">
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
                      </td>
                      <td className="px-2 py-3 align-top">
                        {t.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={t.thumbnail_url} alt="" className="h-8 w-12 rounded object-cover" />
                        ) : (
                          <span className="text-xs text-muted-foreground">N/A</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top">
                        <Link
                          href={`/deliverables/${t.id}`}
                          className="hover:text-primary hover:underline"
                        >
                          {t.title}
                        </Link>
                      </td>
                      <td
                        className="px-2 py-3 align-top text-muted-foreground"
                        title={t.description ?? ""}
                      >
                        {/* Truncation goes on an inner block, not the cell —
                            a table cell doesn't clip its overflow reliably,
                            and the few pixels that escaped were enough to put
                            a scrollbar under the table. */}
                        <span className="block truncate">{t.description || "—"}</span>
                      </td>
                      <td className="px-2 py-3 align-top">
                        <StatusPill text={contentStatusLabel(t.status)} done={done} />
                      </td>
                      <td className="px-2 py-3 align-top">
                        <StatusPill text={editorStatusLabel(t.status)} done={done} />
                      </td>
                      <td
                        className="px-2 py-3 align-top text-muted-foreground"
                        title={t.reject_reason ?? ""}
                      >
                        <span className="block truncate">{t.reject_reason || "—"}</span>
                      </td>
                      <td className="px-2 py-3 text-right align-top">
                        {/* The same editor as the task list — one dialog for
                            editing a task, wherever you reach it from. */}
                        <EditVideoModal
                          deliverable={t}
                          categories={categoryMap}
                          canSendToClient={user.role === "super_admin" || user.role === "crm"}
                          canDelete={user.role === "super_admin"}
                          assignees={assignees}
                          canUploadVideo={user.role !== "crm"}
                          postCountries={user.role === "super_admin" ? POST_COUNTRIES : []}
                          postCountry={POST_COUNTRIES[0].key}
                          scheduledAtLocal={utcToLocalInput(t.scheduled_at, POST_COUNTRIES[0].key)}
                        />
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
