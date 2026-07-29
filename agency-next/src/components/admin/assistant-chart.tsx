"use client";

import type { AssistantChart } from "@/lib/assistant";

// Hand-drawn SVG rather than a charting library: two shapes don't justify the
// bundle, and inline SVG styles cleanly in both themes.
const COLOURS = ["#ea580c", "#f59e0b", "#8b5cf6", "#0ea5e9", "#10b981", "#ef4444", "#ec4899"];

function Pie({ slices, title }: { slices: { label: string; value: number }[]; title: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return null;

  const R = 52;
  const C = 60;
  let angle = -Math.PI / 2; // start at twelve o'clock

  const paths = slices.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const x1 = C + R * Math.cos(angle);
    const y1 = C + R * Math.sin(angle);
    angle += sweep;
    const x2 = C + R * Math.cos(angle);
    const y2 = C + R * Math.sin(angle);
    // A single slice can't be drawn as an arc — it's the whole circle.
    const d =
      slices.length === 1
        ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} Z`
        : `M ${C} ${C} L ${x1} ${y1} A ${R} ${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
    return <path key={i} d={d} fill={COLOURS[i % COLOURS.length]} />;
  });

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-xs font-medium">{title}</p>
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 120 120" className="h-28 w-28 shrink-0" role="img" aria-label={title}>
          {paths}
        </svg>
        <ul className="min-w-0 flex-1 space-y-1">
          {slices.map((s, i) => (
            <li key={s.label} className="flex items-center gap-1.5 text-xs">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: COLOURS[i % COLOURS.length] }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
              <span className="font-medium tabular-nums">{s.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Bars({ slices, title }: { slices: { label: string; value: number }[]; title: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-xs font-medium">{title}</p>
      <ul className="space-y-2">
        {slices.map((s, i) => (
          <li key={s.label}>
            <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{s.label}</span>
              <span className="shrink-0 font-medium tabular-nums">{s.value}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.max(0, s.value))}%`,
                  background: COLOURS[i % COLOURS.length],
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Chart({ chart }: { chart: AssistantChart }) {
  return chart.kind === "pie" ? (
    <Pie slices={chart.slices} title={chart.title} />
  ) : (
    <Bars slices={chart.slices} title={chart.title} />
  );
}
