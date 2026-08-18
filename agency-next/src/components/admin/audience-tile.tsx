import { Card } from "@/components/ui/card";
import type { MonthPoint } from "@/lib/audience";
import { sparkline } from "@/lib/sparkline";

/**
 * One platform's following: where it stands, and how it got there.
 *
 * A stat tile rather than a chart, because the data's job is a single current
 * value with a trend behind it — the number is the answer and the line is the
 * context, not the other way round.
 *
 * **Two tiles, never one chart.** Instagram is in the thousands and Facebook
 * in the dozens. On one pair of axes the smaller account is a flat line along
 * the bottom, and the fix for that — a second y-scale — is the single most
 * misread thing in charting: two series that appear to cross when they never
 * met. Separate tiles give each account its own scale honestly, and nothing is
 * lost, because nobody compares an Instagram follower to a Facebook one.
 */

/** The two hues, each validated against its own surface rather than picked. */
const TONES = {
  instagram: {
    /* rose-500 — passes on both surfaces, so it does not change between them. */
    line: "text-[#f43f5e] dark:text-[#f43f5e]",
    chip: "bg-[#f43f5e]/12 text-[#e11d48] dark:text-[#fb7185]",
  },
  facebook: {
    /* sky-500 on light; sky-600 in the dark, where 500 sits outside the
       lightness band the palette holds its steps to. Chosen by the validator,
       not by eye — a lighter blue looked right and measured wrong. */
    line: "text-[#0ea5e9] dark:text-[#0284c7]",
    chip: "bg-[#0ea5e9]/12 text-[#0284c7] dark:text-[#38bdf8]",
  },
} as const;

const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);

const monthLabel = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
};


export function AudienceTile({
  platform,
  label,
  handle,
  followers,
  history,
  change,
}: {
  platform: keyof typeof TONES;
  label: string;
  /** @handle or Page name — whose account this is. */
  handle: string | null;
  followers: number;
  history: MonthPoint[];
  change: number | null;
}) {
  const tone = TONES[platform];
  const W = 168;
  const H = 44;
  // Two points is the fewest that can be a line — sparkline() returns null
  // below that, and the tile simply carries the number until next month
  // gives it one.
  const plot = sparkline(history, W, H);

  return (
    <Card className="flex-1 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Text in text tokens; the coloured line beside it carries the
              identity. A number wearing the series colour reads as a status. */}
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
            {num(followers)}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {handle ?? "followers"}
          </p>
        </div>

        {plot ? (
          <div className="shrink-0">
            <svg
              width={W}
              height={H}
              viewBox={`0 0 ${W} ${H}`}
              className={tone.line}
              role="img"
              aria-label={`${label}: ${history.map((p) => `${monthLabel(p.month)} ${p.followers}`).join(", ")}`}
            >
              <path d={plot.area} fill="currentColor" opacity="0.10" />
              <path
                d={plot.line}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* The endpoint is emphasised because "where it is now" is the
                  one point on the line worth finding. A ring in the surface
                  colour keeps it legible where it sits on the fill. */}
              <circle
                cx={plot.points[plot.points.length - 1].x}
                cy={plot.points[plot.points.length - 1].y}
                r="4"
                fill="currentColor"
                stroke="var(--card)"
                strokeWidth="2"
              />
              {/* Hit targets wider than the marks, each naming its own month.
                  A native <title> is a real hover layer that costs no client
                  component on a page that is otherwise all server-rendered. */}
              {plot.points.map((p) => (
                <rect
                  key={p.month}
                  x={Math.max(0, p.x - W / (plot.points.length * 2))}
                  y={0}
                  width={W / plot.points.length}
                  height={H}
                  fill="transparent"
                >
                  <title>{`${monthLabel(p.month)} — ${num(p.followers)}`}</title>
                </rect>
              ))}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
              {/* Only the ends are labelled. A label under every point is six
                  numbers competing with the one that matters. */}
              <span>{monthLabel(history[0].month)}</span>
              <span>{monthLabel(history[history.length - 1].month)}</span>
            </div>
          </div>
        ) : null}
      </div>

      {change !== null ? (
        <p className="mt-3">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone.chip}`}
          >
            {change > 0 ? "▲" : change < 0 ? "▼" : "—"} {num(Math.abs(change))}
          </span>{" "}
          <span className="text-xs text-muted-foreground">since last month</span>
        </p>
      ) : (
        /* Said plainly rather than shown as +0, which would claim a flat month
           nobody was watching. */
        <p className="mt-3 text-xs text-muted-foreground">
          Growth appears once there is a second month to compare.
        </p>
      )}
    </Card>
  );
}
