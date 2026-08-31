"use client";

/**
 * The shape of the spend, which the table underneath cannot show.
 *
 * The day-by-day table has every number in it and is the right thing to read a
 * figure off. It is the wrong thing for the question people actually bring to
 * this page — "is this working, and since when" — because a run of numbers
 * does not have a shape until you draw it.
 *
 * ## Three charts, not one
 *
 * Spend, leads and cost per lead have nothing in common but their x axis. On
 * one frame they would need two or three y-scales, and two y-scales is the
 * mistake that makes series appear to cross when they never met. So: small
 * multiples, one measure each, sharing the days.
 *
 * ## Columns, not lines
 *
 * These are discrete daily totals. A line between them would draw readings
 * that were never taken — there is no "half past Tuesday" figure for a day's
 * spend. Same reasoning as the growth board next door, and the same marks:
 * thin, rounded ends on the baseline, a 2px gap of surface between them.
 *
 * ## A gap is not a zero
 *
 * Cost per lead is null on a day with no leads, and that is not the same fact
 * as "a lead cost nothing". A null day draws no column and the tooltip says
 * so, exactly as the table shows a dash.
 *
 * Hues come from `chart-palette`, and were put through the validator against
 * both surfaces rather than picked. The green carries a contrast warning on
 * the light surface, which is discharged the way the skill requires: every
 * chart writes its headline value out, and the whole table is on the page.
 */
import { useId, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ADS } from "@/lib/chart-palette";

export type AdChartDay = {
  date: string;
  spend: number;
  leads: number;
  costPerLead: number | null;
};

const dayLabel = (d: string) => {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return String(d).slice(0, 10);
  return new Date(y, m - 1, day).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

/**
 * One measure across the days in range.
 *
 * `format` rather than a number: money wants its currency and a count does
 * not, and the tooltip, the headline and the screen-reader description all
 * have to say the same thing.
 */
function Columns({
  days,
  pick,
  tone,
  title,
  hint,
  format,
}: {
  days: AdChartDay[];
  pick: (d: AdChartDay) => number | null;
  tone: { light: string; dark: string };
  title: string;
  hint: string;
  format: (v: number) => string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const values = days.map(pick);
  const max = Math.max(...values.map((v) => v ?? 0));
  const H = 120;
  const w = 100 / Math.max(1, days.length);
  /*
   * The gap between columns, and why it is not simply 2.
   *
   * The growth board next door uses a flat 2 because it always draws twelve
   * months: each column is 8.3 units wide and loses 2 to the gap. A range here
   * can be four weeks, which is 3.6 units a column — and a flat 2 would leave
   * a 1.6-unit bar inside a 2-unit space, so the gaps would be wider than the
   * marks and the chart would read as stripes of background.
   *
   * Capped at three tenths of the column instead, so the separation is there
   * at any range and the mark always dominates the space it sits in.
   */
  const gap = Math.min(2, w * 0.3);

  /*
   * The total for a count or an amount; the average for a rate.
   *
   * Adding up cost per lead would produce a number that means nothing —
   * ₹40 on Monday plus ₹60 on Tuesday is not ₹100 a lead. So a rate is
   * averaged over the days that had one, which is the figure somebody would
   * work out by hand.
   */
  const present = values.filter((v): v is number => v !== null);
  const rate = title.startsWith("Cost");
  const headline = present.length
    ? rate
      ? present.reduce((a, b) => a + b, 0) / present.length
      : present.reduce((a, b) => a + b, 0)
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {headline === null ? "—" : format(headline)}
          </span>
          <span className="text-sm text-muted-foreground">
            {headline === null
              ? "nothing in this range"
              : rate
                ? `average over ${present.length} day${present.length === 1 ? "" : "s"} with leads`
                : `across ${days.length} day${days.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* The custom property has to sit on an ancestor of the marks, or the
            fill falls back to the SVG default and every bar renders black. */}
        <div className="relative" data-adbar={id}>
          <svg
            viewBox={`0 0 100 ${H}`}
            preserveAspectRatio="none"
            className="h-24 w-full"
            role="img"
            aria-label={`${title}: ${days
              .map((d, i) => `${dayLabel(d.date)} ${values[i] === null ? "none" : format(values[i]!)}`)
              .join(", ")}`}
          >
            {days.map((d, i) => {
              const v = values[i];
              // A null is a day the measure does not exist for, and draws
              // nothing — not a zero-height bar sitting on the baseline, which
              // reads as "it happened and came to nought".
              const h = v === null || v === 0 ? 0 : Math.max(3, (v / (max || 1)) * (H - 6));
              const x = i * w;
              return (
                <g key={d.date}>
                  {/* The whole column is the hit target. A thin bar is not
                      something anybody can reliably point at. */}
                  <rect
                    x={x}
                    y={0}
                    width={w}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                  {h > 0 ? (
                    <rect
                      x={x + gap / 2}
                      y={H - h}
                      width={Math.max(0.5, w - gap)}
                      height={h}
                      rx={1.5}
                      fill={`var(--adbar-${id}, ${tone.light})`}
                      opacity={hover === null || hover === i ? 1 : 0.4}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
          <style>{`
            [data-adbar="${id}"]{--adbar-${id}:${tone.light}}
            @media (prefers-color-scheme: dark){
              :root:not([data-theme="light"]) [data-adbar="${id}"]{--adbar-${id}:${tone.dark}}
            }
            :root[data-theme="dark"] [data-adbar="${id}"]{--adbar-${id}:${tone.dark}}
          `}</style>

          <div className="mt-1 flex text-[10px] text-muted-foreground" aria-hidden>
            {days.map((d, i) => (
              <span key={d.date} className="truncate text-center" style={{ width: `${w}%` }}>
                {/* Every label on twenty-eight days is unreadable overlap.
                    The first and last anchor the range; the rest are on the
                    tooltip, where a number is wanted one at a time. */}
                {i === 0 || i === days.length - 1 ? dayLabel(d.date) : ""}
              </span>
            ))}
          </div>

          {hover !== null ? (
            <div className="pointer-events-none absolute -top-2 left-0 right-0 text-center">
              <span className="rounded bg-foreground px-2 py-1 text-xs font-medium text-background">
                {dayLabel(days[hover].date)} ·{" "}
                {values[hover] === null ? "no leads" : format(values[hover]!)}
              </span>
            </div>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

/**
 * The three, or nothing at all.
 *
 * One day is not a shape. Drawing a single column and calling it a chart
 * invites a reading — a trend, a direction — that one measurement cannot
 * support, and the stat cards above already say what that day was.
 */
export function AdCharts({ days, currency }: { days: AdChartDay[]; currency: string }) {
  if (days.length < 2) return null;

  // Oldest first: the table is newest-first because it is a log, and a chart
  // read right-to-left is a chart read wrongly.
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));

  const money = (v: number) => {
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        maximumFractionDigits: v >= 100 ? 0 : 2,
      }).format(v);
    } catch {
      return `${currency} ${v.toFixed(2)}`;
    }
  };
  const count = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v));

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Columns
        days={ordered}
        pick={(d) => d.spend}
        tone={ADS.spend}
        title="Spend, day by day"
        hint="What went out, and on which days it went out."
        format={money}
      />
      <Columns
        days={ordered}
        pick={(d) => d.leads}
        tone={ADS.leads}
        title="Leads, day by day"
        hint="What came back. A day with none has no column."
        format={count}
      />
      <Columns
        days={ordered}
        pick={(d) => d.costPerLead}
        tone={ADS.costPerLead}
        title="Cost per lead"
        hint="That day's spend over that day's leads. Nothing on a day with no leads — which is not the same as a lead costing nothing."
        format={money}
      />
    </div>
  );
}
