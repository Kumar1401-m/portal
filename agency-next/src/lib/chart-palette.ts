/**
 * The chart palette, in one place because two copies drift.
 *
 * Colour follows the entity, never the chart it happens to be drawn on: likes
 * are the same blue on the analytics board and in the client's PDF, or the two
 * documents are describing different things to the same reader.
 *
 * Every value here came out of the validator rather than out of a preference —
 * lightness band, chroma floor, colourblind separation and contrast, checked
 * against the light surface and again against the dark one. Changing a hex
 * means running it again; the pairs that pass are not obvious by eye.
 *
 * No `server-only` marker on purpose: this is plain data, and it is read by a
 * client chart and a server-rendered report alike.
 */

/** A hue with a step chosen for each surface. */
export type ChartHue = { light: string; dark: string };

/**
 * Two sequential contexts, each its own one-hue ramp.
 *
 * Followers and reach are separate measures on separate charts. They are never
 * two series on one frame — two y-scales make two lines appear to cross when
 * they never met, which is the single most misread thing in charting.
 */
export const SERIES: Record<"followers" | "reach", ChartHue> = {
  followers: { light: "#2a78d6", dark: "#3987e5" },
  reach: { light: "#eb6834", dark: "#d95926" },
};

/**
 * The engagement breakdown, in fixed order.
 *
 * Assigned by slot and never cycled: if saves drop to zero one month, shares
 * keep their yellow rather than sliding up into green. A filter that changes
 * how many series are present must not repaint the survivors.
 */
export const ENGAGEMENT = [
  { key: "likes", label: "Likes", light: "#2a78d6", dark: "#3987e5" },
  { key: "comments", label: "Comments", light: "#eb6834", dark: "#d95926" },
  { key: "saves", label: "Saves", light: "#1baf7a", dark: "#199e70" },
  { key: "shares", label: "Shares", light: "#eda100", dark: "#c98500" },
] as const;

export type EngagementKey = (typeof ENGAGEMENT)[number]["key"];

/**
 * The ad board's three measures, each on its own frame.
 *
 * Spend, leads and cost per lead share nothing but their x axis, so they are
 * never two series on one chart — three small multiples instead, one measure
 * each. That is also why these hues need only be told apart *between cards*
 * rather than between adjacent marks.
 *
 * Assigned by measure and never cycled, like the block above: a range with no
 * leads in it must not slide cost per lead into the colour leads was using.
 *
 * Run through the validator against both surfaces rather than picked:
 *
 *   light #fcfcfb — lightness, chroma, CVD ΔE 9.2, normal-vision ΔE 24.0 pass
 *   dark  #1a1a19 — all five pass, contrast included
 *
 * The one warning is the green against the light surface at 2.74:1, which the
 * skill says must be discharged rather than dismissed: every chart writes its
 * headline value out in text, and the whole day-by-day table sits underneath.
 */
export const ADS: Record<"spend" | "leads" | "costPerLead", ChartHue> = {
  spend: { light: "#eb6834", dark: "#d95926" },
  leads: { light: "#1baf7a", dark: "#199e70" },
  costPerLead: { light: "#2a78d6", dark: "#3987e5" },
};
