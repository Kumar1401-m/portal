import Link from "next/link";
import { ClipboardList, ArrowRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalContent } from "@/lib/portal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { serviceDef } from "@/lib/services";
import { label, fmtDate, cn } from "@/lib/utils";

export const metadata = { title: "Content · NVK Media" };
export const dynamic = "force-dynamic";

export default async function PortalContentPage() {
  const user = await requireUser(["client"]);
  const items = user.clientId ? await getPortalContent(user.clientId) : [];

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <ClipboardList className="h-6 w-6 text-primary" /> Your content
      </h1>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No content yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const needsReview = ["content_review", "review"].includes(it.status);
            return (
              <Card key={it.id} className={cn("border-l-4", serviceDef(it).accent)}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{it.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ServiceBadge task={it} category={it.content_category} />
                      {it.due_date ? fmtDate(it.due_date) : null}
                    </p>
                  </div>
                  <Badge tone={statusTone(it.status)}>{label(it.status)}</Badge>
                  <Link
                    href={`/portal/content/${it.id}`}
                    className={buttonClasses({
                      variant: needsReview ? "default" : "ghost",
                      size: "sm",
                    })}
                  >
                    {needsReview ? "Review" : "View"} <ArrowRight className="h-4 w-4" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
