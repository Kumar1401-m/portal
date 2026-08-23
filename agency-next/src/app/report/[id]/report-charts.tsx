/**
 * The same charts, for the page that gets printed.
 *
 * Deliberately not the interactive ones. A hover tooltip is the wrong answer on
 * paper: nobody can point at a printed bar, so every value a reader needs has
 * to be written down. These are the same forms and the same hues — shared from
 * `chart-palette` so a like is the same blue in the client's PDF as on the
 * board the agency reads — with the interaction traded for labels.
 *
 * A server component, so it costs the report no JavaScript at all. The PDF is
 * made by the browser's own print dialog, and a chart that needed to hydrate
 * first would print blank on a slow connection.
 */
import { SERIES, ENGAGEMENT } from "@/lib/chart-palette";
import type { GrowthMonth } from "@/lib/analytics";

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(n);

const monthLabel = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
};

/**
 * One measure across the months, with the last value written out.
 *
 * `print-color-adjust: exact` is the line that matters here: browsers strip
 * fills when printing to save ink, and a bar chart printed without its bars is
 * a row of empty rectangles.
 */
function Bars({
  months,
  pick,
  hue,
  title,
  note,
}: {
  months: GrowthMonth[];
  pick: (m: GrowthMonth) => number | null;
  hue: { light: string };
  title: string;
  note: string;
}) {
  const values = months.map(pick);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const H = 90;
  const w = 100 / Math.max(1, months.length);

  const filled = values.filter((v): v is number => v !== null);
  const last = filled.length ? filled[filled.length - 1] : null;
  const before = filled.length > 1 ? filled[filled.length - 2] : null;
  const delta = last !== null && before !== null ? last - before : null;

  return (
    <div className="break-inside-avoid">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-sm tabular-nums">
          <b>{last === null ? "—" : fmt(last)}</b>
          {delta !== null ? (
            <span className="ml-1 text-neutral-500">
              ({delta >= 0 ? "+" : ""}
              {fmt(delta)})
            </span>
          ) : null}
        </span>
      </div>

      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        className="mt-2 h-20 w-full"
        style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}
        role="img"
        aria-label={`${title}: ${months
          .map((m, i) => `${monthLabel(m.month)} ${values[i] ?? 0}`)
          .join(", ")}`}
      >
        {months.map((m, i) => {
          const v = values[i] ?? 0;
          const h = v === 0 ? 0 : Math.max(2, (v / max) * (H - 4));
          return h > 0 ? (
            <rect
              key={m.month}
              x={i * w + 1}
              y={H - h}
              width={Math.max(0.5, w - 2)}
              height={h}
              rx={1.2}
              fill={hue.light}
            />
          ) : null;
        })}
      </svg>

      <div className="flex text-[9px] text-neutral-500" aria-hidden>
        {months.map((m, i) => (
          <span key={m.month} className="text-center" style={{ width: `${w}%` }}>
            {i % 2 === months.length % 2 ? monthLabel(m.month) : ""}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{note}</p>
    </div>
  );
}

/** Part-to-whole, four segments, every one of them labelled with its number. */
function Mix({ months }: { months: GrowthMonth[] }) {
  const totals = ENGAGEMENT.map((s) => ({
    ...s,
    value: months.reduce((t, m) => t + Number(m[s.key] ?? 0), 0),
  }));
  const total = totals.reduce((t, s) => t + s.value, 0);
  if (total === 0) return null;

  const R = 46;
  const C = 2 * Math.PI * R;
  const arcs = totals.reduce<{ start: number; dash: number }[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    const start = prev ? prev.start + prev.dash : 0;
    return [...acc, { start, dash: (s.value / total) * C }];
  }, []);

  return (
    <div className="break-inside-avoid">
      <h3 className="text-sm font-medium">What the engagement was</h3>
      <div className="mt-2 flex items-center gap-5">
        <svg
          viewBox="0 0 120 120"
          className="h-24 w-24 shrink-0"
          style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}
          role="img"
          aria-label={totals.map((s) => `${s.label} ${s.value}`).join(", ")}
        >
          <g transform="rotate(-90 60 60)">
            {totals.map((s, i) => (
              <circle
                key={s.key}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                strokeWidth={16}
                stroke={s.light}
                /* 2px of paper between segments, so two fills never read as one. */
                strokeDasharray={`${Math.max(0, arcs[i].dash - 2)} ${C}`}
                strokeDashoffset={-arcs[i].start}
              />
            ))}
          </g>
        </svg>

        <ul className="flex-1 space-y-1 text-xs">
          {totals.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{
                  background: s.light,
                  printColorAdjust: "exact",
                  WebkitPrintColorAdjust: "exact",
                }}
              />
              <span className="text-neutral-500">{s.label}</span>
              <span className="ml-auto tabular-nums font-medium">{fmt(s.value)}</span>
              <span className="w-9 text-right tabular-nums text-neutral-500">
                {Math.round((s.value / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ReportCharts({ months }: { months: GrowthMonth[] }) {
  if (!months.length) return null;
  const anyFollowers = months.some((m) => m.followers !== null);
  const anyReach = months.some((m) => m.reach > 0);
  if (!anyFollowers && !anyReach) return null;

  return (
    <section className="mt-8 break-inside-avoid">
      <h2 className="text-base font-semibold">Month by month</h2>
      <p className="mt-0.5 text-xs text-neutral-500">
        The last {months.length} months, so this month has something to be measured
        against.
      </p>

      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        {anyFollowers ? (
          <Bars
            months={months}
            pick={(m) => m.followers}
            hue={SERIES.followers}
            title="Followers"
            note="Where each month finished, not its average."
          />
        ) : null}
        {anyReach ? (
          <Bars
            months={months}
            pick={(m) => m.reach}
            hue={SERIES.reach}
            title="Accounts reached"
            note="From the posts published in that month, counted once each."
          />
        ) : null}
      </div>

      <div className="mt-6">
        <Mix months={months} />
      </div>
    </section>
  );
}
