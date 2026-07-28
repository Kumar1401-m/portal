import Link from "next/link";
import { Image as ImageIcon, ExternalLink, MessageSquareWarning, ArrowRight } from "lucide-react";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { getPosters, posterDone, posterInReview } from "@/lib/posters";
import { quickStatus } from "../deliverables/actions";
import { PosterSubmitForm } from "./poster-submit";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { StatCard } from "@/components/ui/stat-card";
import { SERVICES } from "@/lib/services";
import { label, fmtDate, cn } from "@/lib/utils";

export const metadata = { title: "Posters · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function PosterPage() {
  const user = await requireUser(STAFF_ROLES);
  const posters = await getPosters(user);
  const isDesigner = user.role === "poster_designer";

  const todo = posters.filter((p) => !posterDone(p.status) && !posterInReview(p.status));
  const inReview = posters.filter((p) => posterInReview(p.status));
  const done = posters.filter((p) => posterDone(p.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ImageIcon className="h-6 w-6 text-primary" />
          Posters
        </h1>
        <p className="text-sm text-muted-foreground">
          {isDesigner ? "Your assigned poster designs." : "All poster tasks across clients."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="To design" value={todo.length} tone="amber" />
        <StatCard title="In review" value={inReview.length} tone="indigo" />
        <StatCard title="Completed" value={done.length} tone="emerald" />
      </div>

      {posters.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No poster tasks {isDesigner ? "assigned to you" : "yet"}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {posters.map((p) => {
            const done_ = posterDone(p.status);
            const review = posterInReview(p.status);
            return (
              <Card
                key={p.id}
                className={cn("border-l-4", SERVICES.poster_designing.accent)}
              >
                <CardContent className="space-y-3 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/deliverables/${p.id}`}
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {p.title}
                        </Link>
                        <ServiceBadge task={p} category={p.content_category} />
                        <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.company_name}
                        {!isDesigner && p.designer_name ? ` · 🎨 ${p.designer_name}` : ""}
                        {p.due_date ? ` · due ${fmtDate(p.due_date)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.edited_link ? (
                        <a
                          href={p.edited_link}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonClasses({ variant: "ghost", size: "sm" })}
                        >
                          <ExternalLink className="h-4 w-4" /> Open design
                        </a>
                      ) : null}
                      {/* Sending to the client is reserved for super_admin. */}
                      {!isDesigner && p.status === "caption_ready" && user.role === "super_admin" ? (
                        <form action={quickStatus}>
                          <input type="hidden" name="deliverable_id" value={p.id} />
                          <input type="hidden" name="status" value="review" />
                          <Button type="submit" size="sm">
                            Approve &amp; send to client <ArrowRight className="h-4 w-4" />
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  </div>

                  {p.reject_reason ? (
                    <div className="flex items-start gap-2 rounded-md bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] p-3 text-sm">
                      <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <div>
                        <span className="font-medium text-destructive">Requested change: </span>
                        <span className="whitespace-pre-wrap">{p.reject_reason}</span>
                      </div>
                    </div>
                  ) : null}

                  {/* Designer: submit / update the design link */}
                  {isDesigner && !done_ && !review ? (
                    <PosterSubmitForm deliverableId={p.id} currentLink={p.edited_link} />
                  ) : null}
                  {isDesigner && review ? (
                    <p className="text-sm text-muted-foreground">Submitted — awaiting review.</p>
                  ) : null}
                  {isDesigner && done_ ? (
                    <p className="text-sm text-success">Approved &amp; delivered ✓</p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
