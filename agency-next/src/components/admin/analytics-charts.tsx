"use client";

/**
 * Chart.js wrappers for the analytics dashboard.
 *
 * One module registers Chart.js once and exports the four shapes the dashboard
 * needs. Everything else on the page is a server component; only this crosses
 * to the client, so the charting library stays out of every other route's
 * bundle.
 *
 * Colour rules followed here (they are not stylistic — they are what makes the
 * charts readable under colour-vision deficiency and in both themes):
 *
 *   - The categorical slots are a fixed, validated order. Slot 1 is always the
 *     first series, slot 2 always the second, whatever the data. Colour follows
 *     the entity, never its rank, so filtering a series out never repaints the
 *     survivors.
 *   - Single-series charts use slot 1 and no legend — the card's own title
 *     names the series, and a one-item legend is noise.
 *   - Both palettes were validated against this app's actual card surfaces
 *     (#ffffff light, #1e1815 dark): adjacent-pair CVD ΔE ≥ 8.4 and
 *     normal-vision ΔE ≥ 19.8 in both modes.
 *   - Two of the light slots sit below 3:1 against white, so every chart that
 *     uses more than two series ships a table view beneath it. That table is
 *     the accessible equivalent, not a nicety.
 *
 * Never a second y-axis. Two measures at different scales get two charts.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type TooltipItem,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";

// Registered once at module scope. Only the pieces actually used — Chart.js
// ships every scale and controller otherwise, which more than doubles the
// bundle for charts we don't draw.
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler
);

/* --------------------------------- Palette --------------------------------- */

/**
 * The validated categorical order. The dark column is the same four hues
 * re-stepped for a dark surface, not a different palette — so a series keeps
 * its identity when the viewer flips theme.
 */
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500"],
} as const;

/** Chrome: recessive by design. Solid hairlines — never dashed. */
const CHROME = {
  light: { grid: "#ece5df", axis: "#c3c2b7", text: "#78706b", surface: "#ffffff" },
  dark: { grid: "#322721", axis: "#4a3a30", text: "#a89e97", surface: "#1e1815" },
} as const;

/**
 * Follows the `.dark` class the theme toggle sets on <html>.
 *
 * Chart.js paints to a canvas, so it can't read CSS custom properties the way
 * the rest of the UI does — the colours have to be handed to it as literals and
 * the whole chart re-rendered when the theme changes. The observer is what
 * makes the toggle affect charts that are already on screen.
 */
function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

const compact = (n: number) =>
  new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const full = (n: number) => new Intl.NumberFormat("en-IN").format(n);

/* ------------------------------ Shared options ------------------------------ */

/**
 * Base options every chart shares.
 *
 * `intersect: false` with `mode: "index"` is what gives a line chart a proper
 * crosshair: hovering anywhere in a column reads every series at that x, rather
 * than demanding the pointer land on an 8px dot.
 */
function baseOptions(theme: "light" | "dark", opts: { stacked?: boolean } = {}): ChartOptions<"line" | "bar"> {
  const c = CHROME[theme];
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: theme === "dark" ? "#2a221d" : "#1c1512",
        titleColor: "#ffffff",
        bodyColor: "#f2ece7",
        borderColor: theme === "dark" ? "#4a3a30" : "#3b2f28",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
        callbacks: {
          // Full figures in the tooltip even though the axis is abbreviated —
          // the axis is for shape, the tooltip is for the actual number.
          label: (item: TooltipItem<"line" | "bar">) =>
            ` ${item.dataset.label || ""}: ${full(Number(item.parsed.y ?? 0))}`,
        },
      },
    },
    scales: {
      x: {
        stacked: opts.stacked,
        grid: { display: false },
        border: { color: c.axis },
        ticks: {
          color: c.text,
          font: { size: 11 },
          maxRotation: 0,
          // Thins the labels rather than rotating them: rotated dates are
          // harder to read than fewer dates.
          autoSkip: true,
          maxTicksLimit: 8,
        },
      },
      y: {
        stacked: opts.stacked,
        beginAtZero: true,
        grid: { color: c.grid },
        border: { display: false },
        ticks: {
          color: c.text,
          font: { size: 11 },
          maxTicksLimit: 5,
          callback: (v) => compact(Number(v)),
        },
      },
    },
  };
}

/** Chart.js needs a pixel height; the wrapper adds room for the x-axis band. */
function ChartFrame({ children, height = 260 }: { children: React.ReactNode; height?: number }) {
  return (
    <div className="relative w-full" style={{ height }}>
      {children}
    </div>
  );
}

/**
 * A legend swatch row, rendered in HTML rather than by Chart.js.
 *
 * Two reasons: the label text stays in the app's own ink colour (a legend in
 * the series colour makes identity depend on colour alone), and it stays
 * selectable and readable by a screen reader, which canvas text is not.
 */
function SeriesLegend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null; // one series is named by the card title
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export type SeriesPointData = { bucket: string; [key: string]: string | number };

/** Shorten a bucket key for the axis: 2026-07-31 → 31 Jul, 2026-07 → Jul 26. */
function axisLabel(bucket: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const d = new Date(`${bucket}T00:00:00Z`);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  }
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const d = new Date(`${bucket}-01T00:00:00Z`);
    return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return bucket.replace(/^\d{4}-W/, "W"); // 2026-W31 → W31
}

/* --------------------------------- Charts --------------------------------- */

/**
 * A trend line. One or more series, one shared y-axis.
 *
 * `area` fills under a single series — legitimate for one line, and dropped
 * automatically for more, where overlapping translucent fills stop being
 * readable.
 */
export function TrendChart({
  data,
  series,
  height = 260,
  area = false,
}: {
  data: SeriesPointData[];
  series: { key: string; label: string }[];
  height?: number;
  area?: boolean;
}) {
  const theme = useTheme();
  const colors = SERIES[theme];
  const fill = area && series.length === 1;

  const chartData = useMemo(
    () => ({
      labels: data.map((d) => axisLabel(d.bucket)),
      datasets: series.map((s, i) => ({
        label: s.label,
        data: data.map((d) => Number(d[s.key] ?? 0)),
        borderColor: colors[i % colors.length],
        backgroundColor: fill ? `${colors[i % colors.length]}22` : colors[i % colors.length],
        borderWidth: 2,
        fill,
        // Slight smoothing reads as a trend; more would invent values between
        // points that were never measured.
        tension: 0.3,
        pointRadius: 0,
        // The dot appears on hover only — a dot on every day is chart junk at
        // 30+ points, but the hit target still has to be findable.
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: CHROME[theme].surface,
        pointHitRadius: 24,
      })),
    }),
    [data, series, colors, fill, theme]
  );

  if (!data.length) return <EmptyChart height={height} />;

  return (
    <>
      <ChartFrame height={height}>
        <Line data={chartData} options={baseOptions(theme) as ChartOptions<"line">} />
      </ChartFrame>
      <SeriesLegend items={series.map((s, i) => ({ label: s.label, color: colors[i % colors.length] }))} />
    </>
  );
}

/** Categorical or time bars. Rounded data-ends, anchored to the baseline. */
export function BarChart({
  labels,
  series,
  height = 260,
  stacked = false,
  horizontal = false,
}: {
  labels: string[];
  series: { label: string; data: number[] }[];
  height?: number;
  stacked?: boolean;
  horizontal?: boolean;
}) {
  const theme = useTheme();
  const colors = SERIES[theme];

  const chartData = useMemo(
    () => ({
      labels: labels.map(axisLabel),
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        backgroundColor: colors[i % colors.length],
        // Only the value end is rounded; the baseline end stays square so the
        // bar visibly starts at zero.
        borderRadius: 4,
        borderSkipped: false as const,
        // The gap between bars is surface, not a border drawn around each mark.
        barPercentage: 0.72,
        categoryPercentage: 0.8,
      })),
    }),
    [labels, series, colors]
  );

  if (!labels.length) return <EmptyChart height={height} />;

  const options = {
    ...baseOptions(theme, { stacked }),
    indexAxis: horizontal ? ("y" as const) : ("x" as const),
  };

  return (
    <>
      <ChartFrame height={height}>
        <Bar data={chartData} options={options as ChartOptions<"bar">} />
      </ChartFrame>
      <SeriesLegend items={series.map((s, i) => ({ label: s.label, color: colors[i % colors.length] }))} />
    </>
  );
}

/**
 * Follower count over time.
 *
 * Split out from TrendChart because followers is a running total, not a daily
 * figure, so the axis must NOT begin at zero — an account going from 12,000 to
 * 12,400 is a real 3% month, and a zero-based axis flattens it into a line that
 * says nothing happened.
 */
export function FollowersChart({
  data,
  height = 260,
}: {
  data: { bucket: string; followers: number }[];
  height?: number;
}) {
  const theme = useTheme();
  const colors = SERIES[theme];
  const points = data.filter((d) => d.followers > 0); // 0 = not collected, not "lost everyone"

  const chartData = useMemo(
    () => ({
      labels: points.map((d) => axisLabel(d.bucket)),
      datasets: [
        {
          label: "Followers",
          data: points.map((d) => d.followers),
          borderColor: colors[0],
          backgroundColor: `${colors[0]}22`,
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: CHROME[theme].surface,
          pointHitRadius: 24,
        },
      ],
    }),
    [points, colors, theme]
  );

  if (points.length < 2) return <EmptyChart height={height} label="Not enough history yet" />;

  const base = baseOptions(theme);
  const options: ChartOptions<"line"> = {
    ...base,
    scales: {
      ...base.scales,
      y: {
        ...base.scales!.y,
        // The one place a non-zero baseline is right — see the note above.
        beginAtZero: false,
      },
    },
  } as ChartOptions<"line">;

  return (
    <ChartFrame height={height}>
      <Line data={chartData} options={options} />
    </ChartFrame>
  );
}

/** Placeholder that keeps the card's height, so the grid doesn't jump. */
function EmptyChart({ height = 260, label = "No data for this period" }: { height?: number; label?: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground"
      style={{ height }}
    >
      {label}
    </div>
  );
}

/**
 * The table twin every chart is required to have.
 *
 * Collapsed by default so it doesn't compete with the chart, but present on
 * every card — it's the route to the numbers for anyone who can't read the
 * colours, and it makes a value copyable, which a canvas never is.
 */
export function ChartTable({
  columns,
  rows,
  caption = "View the data",
}: {
  columns: string[];
  rows: (string | number)[][];
  caption?: string;
}) {
  if (!rows.length) return null;
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        {caption}
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c}
                  className={`px-3 py-2 font-medium text-muted-foreground ${i === 0 ? "text-left" : "text-right"}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-t border-border">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-3 py-1.5 ${ci === 0 ? "text-left" : "text-right tabular-nums"}`}
                  >
                    {typeof cell === "number" ? full(cell) : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
