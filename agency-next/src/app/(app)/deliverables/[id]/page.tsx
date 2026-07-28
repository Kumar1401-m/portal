import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, Calendar, Link2, MessageSquareWarning } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getDeliverable } from "@/lib/deliverables";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { serviceOf } from "@/lib/services";
import { label, fmtDate } from "@/lib/utils";
import { CaptionStudio } from "./caption-studio";
import { WorkflowControls } from "./workflow-controls";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getDeliverable(Number(id));
  return { title: d ? `${d.title} · Deliverable` : "Deliverable" };
}

function Field({ label: l, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{l}</dt>
      <dd className="mt-0.5 text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function DeliverableDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser(ADMIN_ROLES);
  const { id } = await params;
  const d = await getDeliverable(Number(id));
  if (!d) notFound();

  const service = serviceOf(d);
  const isPoster = service === "poster_designing";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-3">
        <Link
          href={`/deliverables?service=${service}`}
          className={buttonClasses({ variant: "ghost", size: "icon" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{d.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-4 w-4" /> {d.company_name}
            </span>
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-4 w-4" /> {fmtDate(d.due_date)}
            </span>
            {d.platform ? <span>{label(d.platform)}</span> : null}
            <ServiceBadge task={d} category={d.content_category} />
          </div>
        </div>
        <Badge tone={statusTone(d.status)}>{label(d.status)}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Brief */}
        <div className="space-y-6 lg:col-span-1">
          <WorkflowControls
            deliverableId={d.id}
            status={d.status}
            canSendToClient={user.role === "super_admin"}
          />

          <Card>
            <CardHeader>
              <CardTitle>Content brief</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-4">
                <Field label="Description / script" value={<span className="whitespace-pre-wrap">{d.description}</span>} />
                <Field label="Hook" value={d.content_hook} />
                <Field label="Language" value={d.language} />
                <Field label="Target audience" value={d.target_audience} />
                <Field label="Promotion" value={d.promotion_type} />
                <Field label="Custom instructions" value={<span className="whitespace-pre-wrap">{d.custom_instructions}</span>} />
                <Field label="Priority" value={<span className="capitalize">{d.priority}</span>} />
              </dl>
            </CardContent>
          </Card>

          {(d.edited_link || d.raw_drive_link) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Links</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.edited_link ? (
                  <a href={d.edited_link} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <Link2 className="h-4 w-4" /> Edited / design link ↗
                  </a>
                ) : null}
                {d.raw_drive_link ? (
                  <a href={d.raw_drive_link} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <Link2 className="h-4 w-4" /> Raw drive link ↗
                  </a>
                ) : null}
              </CardContent>
            </Card>
          )}

          {d.reject_reason ? (
            <Card className="border-[color-mix(in_srgb,var(--destructive)_35%,var(--border))]">
              <CardContent className="flex gap-3 p-5">
                <MessageSquareWarning className="h-5 w-5 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium text-destructive">Client&apos;s requested change</p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{d.reject_reason}</p>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* Caption studio */}
        <div className="lg:col-span-2">
          <CaptionStudio
            deliverableId={d.id}
            initialCaption={d.caption || ""}
            defaultLanguage={d.language || "English"}
            isPoster={isPoster}
          />
        </div>
      </div>
    </div>
  );
}
