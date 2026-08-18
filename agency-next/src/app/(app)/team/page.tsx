import Link from "next/link";
import { Gauge, TriangleAlert, Users, ListChecks, Briefcase, BarChart3 } from "lucide-react";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { teamEfficiency } from "@/lib/effectiveness";
import { Card, CardContent } from "@/components/ui/card";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { WorkloadPanel } from "./workload-panel";
import { DateFilter } from "./date-filter";
import { label, fmtDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

export const metadata = { title: "Team efficiency · NVK Hub" };
export const dynamic = "force-dynamic";

/** ISO date, this process's clock only for defaulting the form. */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const looksLikeDate = (s?: string) => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

/**
 * The colour of a percentage.
 *
 * Four bands, because "did they clear their capacity" and "how far past it did
 * they get" are different questions and one colour cannot answer both. Beyond
 * capacity is violet rather than a brighter green: it is not more correct than
 * hitting it, it is a different thing, and often means the capacity is wrong.
 */
function band(pct: number) {
  if (pct >= 100) return "bg-violet-600 text-white";
  if (pct >= 80) return "bg-emerald-600 text-white";
  if (pct >= 50) return "bg-amber-500 text-white";
  return "bg-rose-600 text-white";
}

/**
 * Team efficiency: what was delivered against what could have been.
 *
 * `deliveries ÷ (days × capacity per day)`. Eight a day across eleven days is
 * a capacity of 88, so 147 against it is 167%. Never capped — a capacity
 * exists to show who is past it, and rounding everyone down to 100% throws
 * away the only interesting half of the answer.
 *
 * Leaves, holidays and working days are deliberately not here. The portal does
 * not track attendance, so any figure it printed under those headings would be
 * invented, and an invented denominator quietly makes every percentage wrong.
 * Days in the range is a number it actually knows.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requireUser(SUPER_ADMIN_ROLES);
  const sp = await searchParams;

  const now = new Date();
  const defaultFrom = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const defaultTo = iso(now);
  const rawFrom = looksLikeDate(sp.from) ? sp.from! : defaultFrom;
  const rawTo = looksLikeDate(sp.to) ? sp.to! : defaultTo;
  // Backwards dates are swapped rather than refused: it is obvious what was
  // meant, and an empty report looks like a month with no work in it.
  const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];

  const data = await teamEfficiency(from, to);

  return (
    <div className="space-y-5">
      {/* A titled band rather than a bare heading — this is a report, and it
          is read as one thing rather than scanned with the rest of the page. */}
      <div className="rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-5 text-white shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Gauge className="h-5 w-5" />
          Team Efficiency Report
        </h1>
        <p className="mt-0.5 text-sm text-white/85">
          {fmtDate(from)} – {fmtDate(to)} · {data.days} day{data.days === 1 ? "" : "s"}
          {data.totals.efficiency !== null ? (
            <>
              {" "}
              · team {data.totals.efficiency}% ({data.totals.deliveriesMeasured} of{" "}
              {data.totals.capacity} possible)
            </>
          ) : null}
        </p>
      </div>

      <DateFilter from={from} to={to} />

      {!data.ready ? (
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <TriangleAlert className="mx-auto h-8 w-8 text-warning" />
            <p className="text-sm text-muted-foreground">
              The capacity column is missing from the database.
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Settings → Database → apply pending changes
            </Link>
          </CardContent>
        </Card>
      ) : data.members.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No active team members to report on.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table dense>
            <THead>
              <tr>
                <th className="w-10 text-right">#</th>
                <th>
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" /> Employee
                  </span>
                </th>
                <th>
                  <span className="inline-flex items-center gap-1.5">
                    <Briefcase className="h-3.5 w-3.5" /> Role
                  </span>
                </th>
                <th className="text-center">
                  <span className="inline-flex items-center gap-1.5">
                    <ListChecks className="h-3.5 w-3.5" /> Deliveries
                  </span>
                </th>
                <th className="text-center">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" /> Capacity / day
                  </span>
                </th>
                <th className="text-center">
                  <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="h-3.5 w-3.5" /> Efficiency
                  </span>
                </th>
              </tr>
            </THead>
            <TBody>
              {data.members.map((m, i) => (
                <TR key={m.id}>
                  <TD className="text-right tabular-nums text-muted-foreground">{i + 1}</TD>
                  <TD className="font-medium">{m.name}</TD>
                  <TD>
                    <span className="rounded-md bg-sky-500/12 px-2 py-1 text-xs font-medium text-sky-700 dark:text-sky-300">
                      {label(m.role)}
                    </span>
                  </TD>
                  <TD className="text-center">
                    <span className="rounded-md bg-emerald-500/12 px-2 py-0.5 text-sm font-medium tabular-nums text-emerald-700 dark:text-emerald-300">
                      {m.deliveries}
                    </span>
                  </TD>
                  <TD className="text-center tabular-nums">
                    {m.capacityPerDay > 0 ? (
                      m.capacityPerDay
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  {/*
                    No capacity means no percentage. A red 0% for someone
                    nobody set a capacity for is a lie about them, not a
                    measurement.
                  */}
                  <TD className="text-center">
                    {m.efficiency === null ? (
                      <span className="text-xs text-muted-foreground">Not set</span>
                    ) : (
                      <span
                        className={cn(
                          "inline-block min-w-[3.5rem] rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
                          band(m.efficiency)
                        )}
                        title={`${m.deliveries} of ${m.capacity} possible over ${data.days} days`}
                      >
                        {m.efficiency}%
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>

            {/*
              The column added up.

              Deliveries is everyone's, because "how many did we do" is a
              question about the whole team. The percentage beside it is not
              that number over the capacity total, though — it counts only
              people who have a capacity, or someone nobody set one for would
              push the team's figure up on their behalf.

              When those two differ the row says so ("401 scored") rather than
              printing a total that visibly refuses to divide.
            */}
            <tfoot className="border-t-2 border-border bg-muted/40 font-medium">
              <tr>
                <td className="px-2 py-3" />
                <td className="px-2 py-3">Total</td>
                <td className="px-2 py-3 text-xs font-normal text-muted-foreground">
                  {data.totals.people} {data.totals.people === 1 ? "person" : "people"}
                  {data.totals.measured < data.totals.people
                    ? ` · ${data.totals.measured} with capacity`
                    : ""}
                </td>
                <td className="px-2 py-3 text-center tabular-nums">
                  {data.totals.deliveries}
                  {data.totals.deliveries !== data.totals.deliveriesMeasured ? (
                    <div className="text-xs font-normal text-muted-foreground">
                      {data.totals.deliveriesMeasured} scored
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-3 text-center tabular-nums">
                  {data.totals.capacityPerDay > 0 ? (
                    <>
                      {data.totals.capacityPerDay}
                      <div className="text-xs font-normal text-muted-foreground">
                        {data.totals.capacity} over {data.days} day
                        {data.days === 1 ? "" : "s"}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-3 text-center">
                  {data.totals.efficiency === null ? (
                    <span className="text-xs font-normal text-muted-foreground">Not set</span>
                  ) : (
                    <span
                      className={cn(
                        "inline-block min-w-[3.5rem] rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
                        band(data.totals.efficiency)
                      )}
                      title={`${data.totals.deliveriesMeasured} of ${data.totals.capacity} possible`}
                    >
                      {data.totals.efficiency}%
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </Table>

          {/* The definition beside the numbers. Leaves and holidays are not
              here because nothing in the portal tracks them, and a denominator
              nobody measured would make every row quietly wrong. */}
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Efficiency is deliveries ÷ (days in range × capacity per day). A task counts on the
            day it reached editing hand-off, review, approval or posting. Capacity is set per
            person in{" "}
            <Link href="/settings" className="text-primary hover:underline">
              Settings → Team
            </Link>
            ; anyone without one is listed but not scored.
          </p>
        </Card>
      )}

      {/* Below the efficiency report on purpose: that one grades the period
          just gone, this one is about the work still in front of everybody. */}
      <WorkloadPanel />

      <div className="flex justify-end">
        <Link href="/settings" className={buttonClasses({ variant: "outline", size: "sm" })}>
          <Users className="h-4 w-4" /> Set capacity
        </Link>
      </div>
    </div>
  );
}
