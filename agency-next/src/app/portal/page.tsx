import Link from "next/link";
import {
  ClipboardList,
  Clock,
  FileText,
  ArrowRight,
  Upload,
  Send,
  CalendarClock,
  ExternalLink,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalOverview } from "@/lib/portal";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceDot } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { money, label, fmtDate } from "@/lib/utils";
import { RawFootagePopup } from "./raw-footage-popup";

export const metadata = { title: "NVK Media" };
export const dynamic = "force-dynamic";

export default async function PortalDashboard() {
  const user = await requireUser(["client"]);
  const overview = user.clientId ? await getPortalOverview(user.clientId) : null;

  if (!overview) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Your client profile isn&apos;t linked yet. Please contact the agency.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Opens on arrival for everything still missing footage, planned slots
          included — asked for explicitly, so that collecting links is the
          first thing the dashboard does rather than something to find. */}
      <RawFootagePopup items={overview.raw_needed_items} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hi {overview.company_name} 👋</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s where your content stands.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Content this month" value={overview.month.total} icon={ClipboardList} tone="indigo" />
        {/* Posted is the number a client actually wants: what went out, not
            what was signed off internally. */}
        <StatCard
          title="Posted this month"
          value={overview.month.posted}
          hint={`of ${overview.month.total} planned`}
          icon={Send}
          tone="emerald"
        />
        <StatCard title="Awaiting your review" value={overview.month.awaiting} icon={Clock} tone="amber" />
        <Link href="/portal/invoices" className="block">
          <StatCard
            title="Invoices due"
            value={money(overview.invoices.pending_total)}
            hint={`${overview.invoices.pending_count} unpaid — pay online`}
            icon={FileText}
            tone="rose"
            className="transition-transform hover:-translate-y-0.5"
          />
        </Link>
      </div>

      {overview.raw_needed_items.length > 0 ? (
        <Card className="border-[color-mix(in_srgb,var(--warning)_35%,var(--border))]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-warning" /> Send us your footage
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Paste a Google Drive link for each one. It reaches the team straight away and
              editing starts from there.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {overview.raw_needed_items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 py-3">
                  <ServiceDot task={it} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.content_category ? it.content_category : "Ready to start editing"}
                    </p>
                  </div>
                  <Link
                    href={`/portal/content/${it.id}`}
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Add Drive link <ArrowRight className="h-4 w-4" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* What went out, and what is queued to. Together these answer the only
          question a client really has: is my content live or not? */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-success" /> Posted
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.posted_items.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing has gone out yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {overview.posted_items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 py-3">
                    <ServiceDot task={it} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {it.when ? `Posted ${fmtDate(it.when)}` : "Posted"}
                      </p>
                    </div>
                    {it.permalink ? (
                      <a
                        href={it.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonClasses({ variant: "ghost", size: "sm" })}
                      >
                        View <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <Badge tone="success">Live</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-muted-foreground" /> Going out next
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.scheduled_items.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing scheduled yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {overview.scheduled_items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 py-3">
                    <ServiceDot task={it} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {it.when ? `Scheduled for ${fmtDate(it.when)}` : "Approved — date to come"}
                      </p>
                    </div>
                    <Badge tone={it.when ? "info" : "muted"}>
                      {it.when ? "Scheduled" : "Approved"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" /> Waiting for your review
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overview.awaiting_items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing needs your review right now. 🎉
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {overview.awaiting_items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 py-3">
                  <ServiceDot task={it} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.status === "content_review" ? "Content approval" : "Final approval"}
                      {it.content_category ? ` · ${it.content_category}` : ""}
                    </p>
                  </div>
                  <Badge tone={statusTone(it.status)}>{label(it.status)}</Badge>
                  <Link
                    href={`/portal/content/${it.id}`}
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    Review <ArrowRight className="h-4 w-4" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
