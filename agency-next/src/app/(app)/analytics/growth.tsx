"use client";

/**
 * Month by month — the question the rest of this board cannot answer.
 *
 * Everything above is "how did this month go", and a single month has nothing
 * to be bigger than. Growth only appears when the months are put side by side.
 *
 * Three forms, each picked for its job rather than for variety:
 *
 *  - **Followers, per month** — magnitude over time, one series. Columns, not a
 *    line: these are twelve discrete closing counts, and a line between them
 *    would imply readings that were never taken.
 *  - **Reach, per month** — the same job for a second measure, so it gets its
 *    own chart rather than a second axis on the first. Two y-scales on one
 *    frame is the mistake that makes two series appear to cross when they never
 *    met.
 *  - **Engagement mix** — part-to-whole, four segments that always sum to the
 *    whole. A donut earns its place here and nowhere else on this page.
 *
 * No chart library. Twelve bars and four arcs are less code than the wrapper
 * around a dependency would be, and this way the marks obey the house rules
 * exactly: thin, rounded ends on the baseline, a 2px gap of surface between
 * fills, recessive axes, and identity never resting on colour alone.
 */
import { useId, useState } from "react";
import type { CSSProperties } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
/* Shared with the client's PDF, so a like is the same blue in both. */
import { SERIES as HUE, ENGAGEMENT as MIX } from "@/lib/chart-palette";

export type GrowthMonth = {
  month: string;
  posts: number;
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  followers: number | null;
};

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(n);

const monthLabel = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
};



/**
 * One measure, twelve months.
 *
 * Only the newest value is written out. A number over every bar is noise that
 * hides the shape the bars make together, which is the entire point of putting
 * them side by side.
 */
function Columns({
  months,
  pick,
  tone,
  title,
  hint,
}: {
  months: GrowthMonth[];
  pick: (m: GrowthMonth) => number | null;
  tone: { light: string; dark: string };
  title: string;
  hint: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const values = months.map(pick);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const H = 120;
  const gap = 2;
  const w = 100 / Math.max(1, months.length);

  const filled = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  const last = filled.length ? filled[filled.length - 1].v : null;
  const before = filled.length > 1 ? filled[filled.length - 2].v : null;
  const delta = last !== null && before !== null ? last - before : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">
            {last === null ? "—" : fmt(last)}
          </span>
          <span className="text-sm text-muted-foreground">
            {delta === null
              ? "no earlier month to compare against yet"
              : `${delta >= 0 ? "+" : ""}${fmt(delta)} on the month before`}
          </span>
        </div>

        {/*
          * The custom property goes on the element that CONTAINS the svg.
          *
          * It was set on a hidden sibling span, so nothing inherited it and
          * every bar fell back to the SVG default — black. A chart cannot be
          * coloured from a node that is not an ancestor of the marks.
          */}
        <div className="relative" data-bar={id}>
          <svg
            viewBox={`0 0 100 ${H}`}
            preserveAspectRatio="none"
            className="h-28 w-full"
            role="img"
            aria-label={`${title}: ${months
              .map((m, i) => `${monthLabel(m.month)} ${values[i] ?? 0}`)
              .join(", ")}`}
          >
            {months.map((m, i) => {
              const v = values[i] ?? 0;
              const h = v === 0 ? 0 : Math.max(3, (v / max) * (H - 6));
              const x = i * w;
              return (
                <g key={m.month}>
                  {/* The hit target is the whole column. A thin bar is not
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
                      fill={`var(--bar-${id}, ${tone.light})`}
                      opacity={hover === null || hover === i ? 1 : 0.4}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
          <style>{`
            [data-bar="${id}"]{--bar-${id}:${tone.light}}
            @media (prefers-color-scheme: dark){
              :root:not([data-theme="light"]) [data-bar="${id}"]{--bar-${id}:${tone.dark}}
            }
            :root[data-theme="dark"] [data-bar="${id}"]{--bar-${id}:${tone.dark}}
          `}</style>

          <div className="mt-1 flex text-[10px] text-muted-foreground" aria-hidden>
            {months.map((m, i) => (
              <span key={m.month} className="text-center" style={{ width: `${w}%` }}>
                {i % 2 === months.length % 2 ? monthLabel(m.month) : ""}
              </span>
            ))}
          </div>

          {hover !== null ? (
            <div className="pointer-events-none absolute -top-2 left-0 right-0 text-center">
              <span className="rounded bg-foreground px-2 py-1 text-xs font-medium text-background">
                {monthLabel(months[hover].month)} · {fmt(values[hover] ?? 0)}
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
 * What the engagement was made of.
 *
 * Every segment carries its own number and percentage beside its name, which is
 * both the legend and the direct label — and is what discharges the contrast
 * warning the two lighter hues carry on a light surface. Identity never rests
 * on colour alone here.
 */
function Mix({ months }: { months: GrowthMonth[] }) {
  const [hover, setHover] = useState<string | null>(null);

  const totals = MIX.map((s) => ({
    ...s,
    value: months.reduce((t, m) => t + Number(m[s.key] ?? 0), 0),
  }));
  const total = totals.reduce((t, s) => t + s.value, 0);

  const R = 52;
  const C = 2 * Math.PI * R;

  /*
   * Where each arc starts, worked out before drawing rather than accumulated
   * while drawing. A running total mutated inside the map is a render that
   * depends on the order React happens to call it in.
   */
  const arcs = totals.reduce<{ start: number; dash: number }[]>((acc, s2) => {
    const prev = acc[acc.length - 1];
    const start = prev ? prev.start + prev.dash : 0;
    return [...acc, { start, dash: total ? (s2.value / total) * C : 0 }];
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">What the engagement was</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing to break down yet — this fills in once the posts start
            collecting likes, comments, saves and shares.
          </p>
        ) : (
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <svg
              viewBox="0 0 140 140"
              className="h-36 w-36 shrink-0"
              role="img"
              aria-label={totals.map((s) => `${s.label} ${s.value}`).join(", ")}
            >
              <g transform="rotate(-90 70 70)">
                {totals.map((s, i) => {
                  const { start, dash } = arcs[i];
                  return (
                    <circle
                      key={s.key}
                      cx="70"
                      cy="70"
                      r={R}
                      fill="none"
                      strokeWidth={hover === s.key ? 24 : 19}
                      stroke={s.light}
                      /* 2px of surface between segments, so two adjacent fills
                         never read as one mark. */
                      strokeDasharray={`${Math.max(0, dash - 2)} ${C}`}
                      strokeDashoffset={-start}
                      className="transition-[stroke-width] dark:stroke-[var(--slice)]"
                      style={{ "--slice": s.dark } as CSSProperties}
                      onMouseEnter={() => setHover(s.key)}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
              </g>
              <text
                x="70"
                y="67"
                textAnchor="middle"
                className="fill-foreground text-[15px] font-semibold"
              >
                {fmt(total)}
              </text>
              <text x="70" y="81" textAnchor="middle" className="fill-muted-foreground text-[9px]">
                in total
              </text>
            </svg>

            <ul className="w-full space-y-2 text-sm">
              {totals.map((s) => (
                <li
                  key={s.key}
                  className="flex items-center gap-2"
                  onMouseEnter={() => setHover(s.key)}
                  onMouseLeave={() => setHover(null)}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm dark:bg-[var(--slice)]"
                    style={{ background: s.light, "--slice": s.dark } as CSSProperties}
                  />
                  {/* The number wears text tokens, not the series hue — the
                      swatch beside it is what carries identity. */}
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="ml-auto font-medium tabular-nums">{fmt(s.value)}</span>
                  <span className="w-11 text-right text-xs tabular-nums text-muted-foreground">
                    {total ? Math.round((s.value / total) * 100) : 0}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Growth({ months }: { months: GrowthMonth[] }) {
  if (!months.length) return null;
  const anyFollowers = months.some((m) => m.followers !== null);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Month by month</h2>
        <p className="text-sm text-muted-foreground">
          The last {months.length} months, whichever period is picked above — growth
          is the one thing a single month cannot show.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {anyFollowers ? (
          <Columns
            months={months}
            pick={(m) => m.followers}
            tone={HUE.followers}
            title="Followers"
            hint="Where each month finished, not its average — that is what “grew by 40 in July” means."
          />
        ) : null}
        <Columns
          months={months}
          pick={(m) => m.reach}
          tone={HUE.reach}
          title="Accounts reached"
          hint="Summed from the posts published in that month, counted once however many times they were read back."
        />
      </div>

      <Mix months={months} />
    </div>
  );
}
