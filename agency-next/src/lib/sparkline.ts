/**
 * The geometry behind a small trend line.
 *
 * Separated from the component that draws it for one reason: this is the part
 * that can be wrong in a way nobody sees. A colour is wrong on sight; a line
 * plotted from the wrong baseline looks like a perfectly good line and says
 * something false about the business. So it is a pure function with a test,
 * and the component is markup.
 */

export type Point = { month: string; followers: number };

export type Sparkline = {
  points: (Point & { x: number; y: number })[];
  /** The path for the stroked line. */
  line: string;
  /** The same shape closed to the baseline, for the wash underneath. */
  area: string;
};

/**
 * Plotted on the data's own range, not from zero.
 *
 * An account that went 980 → 1,000 against a zero baseline is a flat line
 * across the top, and "did we grow" is the whole question. The cost is that
 * the line exaggerates a small move, which is why the tile prints the number
 * and the change beside it — the line is for shape, the digits for size.
 *
 * A run of identical readings has no range to divide by, so it is drawn down
 * the middle rather than dividing by zero and vanishing.
 */
export function sparkline(history: Point[], w: number, h: number, pad = 3): Sparkline | null {
  if (history.length < 2) return null;

  const vals = history.map((p) => p.followers);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const flat = hi === lo;
  const span = flat ? 1 : hi - lo;

  const x = (i: number) => pad + (i * (w - pad * 2)) / (history.length - 1);
  const y = (v: number) => (flat ? h / 2 : h - pad - ((v - lo) / span) * (h - pad * 2));

  const points = history.map((p, i) => ({ ...p, x: x(i), y: y(p.followers) }));
  const n = (v: number) => Number(v.toFixed(1));

  return {
    points,
    line: points.map((p, i) => `${i ? "L" : "M"}${n(p.x)},${n(p.y)}`).join(" "),
    area:
      `M${n(points[0].x)},${h} ` +
      points.map((p) => `L${n(p.x)},${n(p.y)}`).join(" ") +
      ` L${n(points[points.length - 1].x)},${h} Z`,
  };
}
