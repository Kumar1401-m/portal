import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil, Layers } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { getClientMonth } from "@/lib/reports";
import { queryOne } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { MonthPicker } from "@/components/admin/month-picker";
import { SERVICES, serviceOf, isServiceKey } from "@/lib/services";
import { contentStatusLabel, editorStatusLabel, editorStatusTone } from "@/lib/constants";
import { monthKey, fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [Number(id)]
  );
  return { title: c ? `${c.company_name} · Reports` : "Reports" };
}

/** Coloured count chip, one per category, plus the month's total. */
function Chip({ label, n, className }: { label: string; n: number; className: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-white ${className}`}
    >
      {label}: {n}
    </span>
  );
}

const CHIP_COLOURS = [
  "bg-orange-500",
  "bg-purple-600",
  "bg-emerald-600",
  "bg-pink-600",
  "bg-teal-600",
  "bg-indigo-600",
];

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

  const tasks = await getClientMonth(client.id, month, service);

  // Counts per category, in the order they first appear.
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.content_category?.trim() || "Uncategorised";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/reports?month=${month}${service ? `&service=${service}` : ""}`}
          className={buttonClasses({ variant: "ghost", size: "icon" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{client.company_name}</h1>
          {service ? (
            <p className="text-sm text-muted-foreground">{SERVICES[service].label} only</p>
          ) : null}
        </div>
        <MonthPicker month={month} basePath={`/reports/${client.id}`} extra={{ service }} />
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-muted-foreground" />
          Monthly deliverables
        </h2>
        <div className="flex flex-wrap gap-2">
          {[...counts.entries()].map(([name, n], i) => (
            <Chip key={name} label={name} n={n} className={CHIP_COLOURS[i % CHIP_COLOURS.length]} />
          ))}
          <Chip label="Total" n={tasks.length} className="bg-blue-600" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="[&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:text-primary">
                <th>S.No</th>
                <th>Creative type</th>
                <th>Post schedule date</th>
                <th>Promotion type</th>
                <th>Shoot link</th>
                <th>Editor link</th>
                <th>Thumbnail</th>
                <th>Title</th>
                <th>Description</th>
                <th>Content status</th>
                <th>Editor status</th>
                <th>Remarks</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-10 text-center text-muted-foreground">
                    No tasks for {client.company_name} this month. Anything you create for them
                    shows up here.
                  </td>
                </tr>
              ) : (
                tasks.map((t, i) => {
                  const svc = SERVICES[serviceOf(t)];
                  return (
                    <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                      <td className="px-3 py-3 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span className={`h-2 w-2 rounded-full ${svc.dot}`} />
                          {t.content_category || svc.short}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        {t.scheduled_at ? fmtDate(t.scheduled_at) : fmtDate(t.due_date)}
                      </td>
                      <td className="px-3 py-3">
                        {t.promotion_type ? (
                          <Badge tone="info">{t.promotion_type}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {t.raw_drive_link ? (
                          <a href={t.raw_drive_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {t.edited_link ? (
                          <a href={t.edited_link} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {t.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={t.thumbnail_url} alt="" className="h-8 w-12 rounded object-cover" />
                        ) : (
                          <span className="text-xs text-muted-foreground">N/A</span>
                        )}
                      </td>
                      <td className="max-w-[20rem] px-3 py-3">
                        <Link href={`/deliverables/${t.id}`} className="font-medium hover:text-primary hover:underline">
                          {t.title}
                        </Link>
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-3 text-muted-foreground" title={t.description ?? ""}>
                        {t.description || "—"}
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={statusTone(t.status)}>{contentStatusLabel(t.status)}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={editorStatusTone(t.status)}>{editorStatusLabel(t.status)}</Badge>
                      </td>
                      <td className="max-w-[12rem] truncate px-3 py-3 text-muted-foreground" title={t.reject_reason ?? ""}>
                        {t.reject_reason || "—"}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Link
                          href={`/deliverables/${t.id}`}
                          aria-label={`Open ${t.title}`}
                          title={`Open ${t.title}`}
                          className={buttonClasses({ variant: "ghost", size: "icon" })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
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
