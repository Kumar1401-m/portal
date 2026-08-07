import Link from "next/link";
import { ClipboardList, ArrowRight, ExternalLink } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalContent, type PortalContentRow } from "@/lib/portal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import {
  contentStatusLabel,
  contentStatusTone,
  editorStatusLabel,
  editorStatusTone,
} from "@/lib/constants";
import { fmtDate, cn } from "@/lib/utils";

export const metadata = { title: "Content · NVK Media" };
export const dynamic = "force-dynamic";

/** A Drive/preview link, or a plain dash so the column still lines up. */
function LinkCell({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * The month as a schedule.
 *
 * One row per piece of content, in the order it goes out, with the two
 * statuses the agency tracks separately: where the content itself stands, and
 * where the edit stands. A client reading this should be able to answer "what
 * is coming, when, and where has it got to" without opening anything.
 *
 * The same rows become cards on a phone. A fourteen-column table on a 390px
 * screen is not a table, it is a horizontal scrollbar with data hidden behind
 * it, and this is the screen most clients will use.
 */
export default async function PortalContentPage() {
  const user = await requireUser(["client"]);
  const items = user.clientId ? await getPortalContent(user.clientId) : [];

  const needsReview = (it: PortalContentRow) =>
    ["content_review", "review"].includes(it.status);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ClipboardList className="h-6 w-6 text-primary" /> Your content
        </h1>
        <p className="text-sm text-muted-foreground">
          {items.length} item{items.length === 1 ? "" : "s"}, in the order they go out.
        </p>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No content yet.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Table on a real screen. */}
          <Card className="hidden overflow-hidden lg:block">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <tr>
                    <th className="w-12 text-right">#</th>
                    <th>Post date</th>
                    <th>Type</th>
                    <th>Promotion</th>
                    <th>Title</th>
                    <th>Shoot</th>
                    <th>Video</th>
                    <th>Content status</th>
                    <th>Editor status</th>
                    <th className="text-right">Open</th>
                  </tr>
                </THead>
                <TBody>
                  {items.map((it, i) => (
                    <TR key={it.id}>
                      <TD className="text-right tabular-nums text-muted-foreground">{i + 1}</TD>
                      <TD className="whitespace-nowrap tabular-nums">
                        {it.post_date ? (
                          fmtDate(it.post_date)
                        ) : (
                          <span className="text-muted-foreground">Not set</span>
                        )}
                      </TD>
                      <TD>
                        <ServiceBadge task={it} category={it.content_category} />
                      </TD>
                      <TD className="text-muted-foreground">{it.promotion_type || "—"}</TD>
                      <TD className="max-w-[22rem]">
                        <p className="truncate font-medium">{it.title}</p>
                        {it.description ? (
                          <p className="truncate text-xs text-muted-foreground">{it.description}</p>
                        ) : null}
                      </TD>
                      <TD>
                        <LinkCell href={it.raw_drive_link}>View</LinkCell>
                      </TD>
                      <TD>
                        <LinkCell href={it.edited_link}>View</LinkCell>
                      </TD>
                      <TD>
                        <Badge tone={contentStatusTone(it.status)}>
                          {contentStatusLabel(it.status)}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge tone={editorStatusTone(it.status)}>
                          {editorStatusLabel(it.status)}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <Link
                          href={`/portal/content/${it.id}`}
                          className={buttonClasses({
                            variant: needsReview(it) ? "default" : "ghost",
                            size: "sm",
                          })}
                        >
                          {needsReview(it) ? "Review" : "View"}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Card>

          {/* The same schedule on a phone. */}
          <div className="space-y-2 lg:hidden">
            {items.map((it, i) => (
              <Card key={it.id} className={cn("border-l-4 border-l-primary/40")}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{it.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <ServiceBadge task={it} category={it.content_category} />
                        {it.post_date ? fmtDate(it.post_date) : "Date not set"}
                        {it.promotion_type ? `· ${it.promotion_type}` : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={contentStatusTone(it.status)}>
                      {contentStatusLabel(it.status)}
                    </Badge>
                    <Badge tone={editorStatusTone(it.status)}>
                      {editorStatusLabel(it.status)}
                    </Badge>
                    <span className="ml-auto flex items-center gap-3 text-xs">
                      {it.raw_drive_link ? (
                        <LinkCell href={it.raw_drive_link}>Shoot</LinkCell>
                      ) : null}
                      {it.edited_link ? <LinkCell href={it.edited_link}>Video</LinkCell> : null}
                      <Link
                        href={`/portal/content/${it.id}`}
                        className={buttonClasses({
                          variant: needsReview(it) ? "default" : "ghost",
                          size: "sm",
                        })}
                      >
                        {needsReview(it) ? "Review" : "View"}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
