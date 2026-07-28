import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, MessageSquareWarning } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalDeliverable } from "@/lib/portal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { label, fmtDate } from "@/lib/utils";
import { PortalReview } from "./portal-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review · NVK Media" };

export default async function PortalContentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser(["client"]);
  const { id } = await params;
  const d = user.clientId ? await getPortalDeliverable(user.clientId, Number(id)) : null;
  if (!d) notFound();

  const needsReview = ["content_review", "review"].includes(d.status);
  const gate = d.status === "content_review" ? "content" : d.status === "review" ? "final" : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <Link href="/portal/content" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{d.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <ServiceBadge task={d} category={d.content_category} />
            {d.due_date ? `due ${fmtDate(d.due_date)}` : null}
          </p>
        </div>
        <Badge tone={statusTone(d.status)}>{label(d.status)}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {gate ? (
            <div className="rounded-lg border border-primary/30 bg-primary/[0.04] px-4 py-3 text-sm">
              {gate === "content"
                ? "Please review the content below and approve it, or request changes. Once approved, we'll produce the video."
                : "Please review the final version below and approve it, or request changes."}
            </div>
          ) : null}

          {d.edited_link ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <a
                  href={d.edited_link}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses({ variant: "outline" })}
                >
                  <ExternalLink className="h-4 w-4" /> Open the design / video
                </a>
              </CardContent>
            </Card>
          ) : null}

          {d.description ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{d.description}</p>
              </CardContent>
            </Card>
          ) : null}

          {d.caption ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Caption</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{d.caption}</pre>
              </CardContent>
            </Card>
          ) : null}

          {d.reject_reason ? (
            <Card className="border-[color-mix(in_srgb,var(--destructive)_30%,var(--border))]">
              <CardContent className="flex gap-3 p-5">
                <MessageSquareWarning className="h-5 w-5 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium text-destructive">Your requested change</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{d.reject_reason}</p>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="lg:col-span-1">
          {needsReview ? (
            <PortalReview deliverableId={d.id} />
          ) : (
            <Card>
              <CardContent className="p-5 text-sm text-muted-foreground">
                {["approved", "scheduled", "posted", "completed"].includes(d.status)
                  ? "You've approved this — thank you! 🎉"
                  : "Nothing to review right now. We'll notify you when it's ready."}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
