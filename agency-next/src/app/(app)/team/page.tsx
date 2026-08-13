import Link from "next/link";
import { Gauge, CheckCircle2, AlertTriangle, TriangleAlert, Users } from "lucide-react";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { teamEffectiveness, HISTORY_DAYS } from "@/lib/effectiveness";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { label, fmtDate } from "@/lib/utils";

export const metadata = { title: "Team effectiveness · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * Which side of the target a percentage falls on.
 *
 * Amber rather than red below target: a target is a plan for the day, and
 * being short of it at eleven in the morning is not a failure. Red is kept for
 * work that is actually late.
 */
function toneFor(percent: number | null) {
  if (percent === null) return "muted" as const;
  if (percent >= 100) return "success" as const;
  if (percent >= 60) return "warning" as const;
  return "danger" as const;
}

/** The bar behind a percentage. Over 100 fills it and stops. */
function Bar({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const tone = toneFor(percent);
  const fill =
    tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-destructive";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img"
      aria-label={`${percent}% of target`}>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
}

/**
 * Team effectiveness, as a percentage of what was asked for.
 *
 * Its own page rather than a card on the dashboard: it names individuals, it
 * is read deliberately rather than glanced at, and it was making the dashboard
 * a scroll.
 *
 * The number is done ÷ target. Three of three is 100%; four of three is 133%,
 * shown as 133% and not rounded down, because otherwise beating a target looks
 * identical to scraping it — which is the thing a target exists to find out.
 *
 * The team figure counts only people who have a target. Including someone's
 * work when nobody set them a target would push the percentage up for a
 * management oversight.
 */
export default async function TeamPage() {
  await requireUser(SUPER_ADMIN_ROLES);
  const data = await teamEffectiveness();

  if (!data.ready) {
    return (
      <div className="space-y-5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="h-6 w-6 text-primary" /> Team effectiveness
        </h1>
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <TriangleAlert className="mx-auto h-8 w-8 text-warning" />
            <p className="text-sm text-muted-foreground">
              The daily target column is missing.
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Settings → Database → apply pending changes
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const t = data.totals;
  const noTargets = t.withTarget === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Gauge className="h-6 w-6 text-primary" /> Team effectiveness
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.date ? fmtDate(data.date) : "Today"} · against the daily target set for each
            person.
          </p>
        </div>
        <Link href="/settings" className={buttonClasses({ variant: "outline", size: "sm" })}>
          <Users className="h-4 w-4" /> Set targets
        </Link>
      </div>

      {noTargets ? (
        <Card>
          <CardContent className="space-y-2 p-10 text-center">
            <Gauge className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Nobody has a daily target yet, so there is nothing to measure against. Set one
              per person in Settings → Team — a target of 3 met three times is 100%.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Team effectiveness"
              value={t.percent === null ? "—" : `${t.percent}%`}
              icon={Gauge}
              tone={t.percent !== null && t.percent >= 100 ? "emerald" : "amber"}
              hint={`${t.doneWithTarget} finished against ${t.target} asked for`}
            />
            <StatCard
              title="On target"
              value={`${t.onTarget} of ${t.withTarget}`}
              icon={CheckCircle2}
              tone="emerald"
            />
            <StatCard
              title="Open work"
              value={t.open}
              icon={Users}
              tone="sky"
              hint="assigned and not finished"
            />
            <StatCard
              title="Overdue"
              value={t.overdue}
              icon={AlertTriangle}
              tone={t.overdue > 0 ? "rose" : "sky"}
            />
          </div>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-base">By person</CardTitle>
              <p className="text-xs text-muted-foreground">
                Each percentage is that person&apos;s own: what they finished today divided by
                what was asked of them.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table dense>
                <THead>
                  <tr>
                    <th>Member</th>
                    <th className="text-right">Target</th>
                    <th className="text-right">Done</th>
                    <th className="w-40">Effectiveness</th>
                    <th className="text-right">Last {HISTORY_DAYS} days</th>
                    <th className="text-right">Open</th>
                    <th className="text-right">Overdue</th>
                  </tr>
                </THead>
                <TBody>
                  {data.members.map((m) => (
                    <TR key={m.id}>
                      <TD>
                        <span className="font-medium">{m.name}</span>
                        <div className="text-xs text-muted-foreground">{label(m.role)}</div>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {m.target > 0 ? m.target : <span className="text-muted-foreground">—</span>}
                      </TD>
                      <TD className="text-right font-medium tabular-nums">{m.done}</TD>
                      <TD>
                        {/* No target means no verdict — a green tick for having
                            been forgotten is worse than a blank. */}
                        {m.percent === null ? (
                          <span className="text-xs text-muted-foreground">No target set</span>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span
                                className={
                                  m.percent >= 100
                                    ? "text-sm font-semibold text-success"
                                    : "text-sm font-semibold text-warning"
                                }
                              >
                                {m.percent}%
                              </span>
                              {m.percent < 100 ? (
                                <span className="text-xs text-muted-foreground">
                                  {m.target - m.done} to go
                                </span>
                              ) : null}
                            </div>
                            <Bar percent={m.percent} />
                          </div>
                        )}
                      </TD>
                      {/* Days met, not a weekly total: there is no weekly
                          target, and inventing one would score Sundays. */}
                      <TD className="text-right tabular-nums text-muted-foreground">
                        {m.target > 0 ? (
                          <Badge tone={m.hitDays >= 5 ? "success" : "muted"}>
                            {m.hitDays}/{HISTORY_DAYS} days
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TD>
                      <TD className="text-right tabular-nums text-muted-foreground">{m.open}</TD>
                      <TD className="text-right tabular-nums">
                        {m.overdue > 0 ? (
                          <span className="font-medium text-destructive">{m.overdue}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              {/* The definition, beside the numbers rather than in someone's
                  head. `updated_at` is the closest thing the schema has to
                  "when it moved", and an unrelated edit touches it too. */}
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                A task counts on the day it reached editing hand-off, review, approval or
                posting. The team figure counts only people who have a target, so nobody&apos;s
                work inflates it on their behalf. Resets at midnight.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
