/**
 * The colours a chart may use, and how counted things become slices.
 *
 * Pure, and in its own module so the arithmetic can be checked without a test
 * having to import a .tsx file — the same split `content-kinds.ts` has from
 * `content-ai.ts`.
 */

/**
 * Categorical hues, in fixed order.
 *
 * Not picked by eye: run through a palette validator against a white surface —
 * lightness band, chroma floor, colour-blind separation between adjacent
 * pairs, and contrast all pass. The tritan separation between two of them sits
 * in the band that is only allowed alongside a second channel, which is why
 * every slice is drawn with its name and its share beside it rather than
 * relying on the colour to say which is which. That second channel is also
 * what keeps the chart readable out of a black-and-white office printer.
 */
export const SERIES = ["#ea580c", "#2563eb", "#0d9488", "#9333ea", "#db2777"] as const;

/** Everything past the fifth category, folded together. Never a sixth hue. */
export const REST = "#a3a3a3";

export type Slice = { label: string; value: number; color: string };

/**
 * Group counted things into at most five named slices plus "Other".
 *
 * A generated sixth hue is indistinguishable from one of the first five under
 * colour blindness, so the tail folds instead of growing the palette. Nothing
 * is dropped — the folded slices are summed, so the pie still adds up to the
 * number in the middle of it.
 */
export function toSlices(counts: Map<string, number>, keep = 5): Slice[] {
  const sorted = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const slices: Slice[] = sorted.slice(0, keep).map(([label, value], i) => ({
    label,
    value,
    color: SERIES[i % SERIES.length],
  }));
  const rest = sorted.slice(keep).reduce((t, [, n]) => t + n, 0);
  if (rest > 0) slices.push({ label: "Other", value: rest, color: REST });
  return slices;
}
