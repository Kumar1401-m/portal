/**
 * The ads, side by side.
 *
 * The table underneath has every figure and is the right thing to read a
 * number off. It is the wrong thing for "which of these is the outlier",
 * because thirty numbers in a column do not have a shape until you draw them.
 *
 * ## Horizontal bars, not columns
 *
 * These are named categories, not a time series, and the names are long. Ad
 * names run to forty characters and campaign names longer; as column labels
 * they would be rotated, truncated or both. Rows give the label the whole
 * width of a line and put every bar on a common left edge, which is what makes
 * lengths comparable at a glance.
 *
 * ## Two panels, and the second one is chosen, not fixed
 *
 * Spend always. Then whatever `rankAds` actually judged the ads on — cost per
 * lead when there are leads, click rate when there are none. Drawing a cost
 * per lead chart where every value is null is three inches of empty frame, and
 * drawing both invites the reader to compare two scales that share nothing but
 * their rows.
 *
 * Never two measures on one frame: that needs two x-scales, and two scales is
 * the single most misread thing in charting.
 *
 * ## A gap is not a zero
 *
 * An ad with no leads has no cost per lead — that is not "a lead cost nothing".
 * It draws no bar and says why, exactly as the table shows a dash.
 *
 * Hues come from `chart-palette`, which was put through the validator against
 * both surfaces rather than picked by eye.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ADS, type ChartHue } from "@/lib/chart-palette";
import { rankAds, type AdPerf } from "@/lib/ads";

/**
 * How many bars before this stops being readable.
 *
 * ponytail: a flat cap. The dropped ads are named in the caption rather than
 * silently vanishing — a chart that quietly shows twelve of forty reads as
 * "this is all of them".
 */
const MAX_BARS = 12;

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** One measure across the ads, as rows. */
function Panel({
  id,
  title,
  note,
  rows,
  tone,
}: {
  id: string;
  title: string;
  note: string;
  /** `value` null means the measure does not exist for this ad, not zero. */
  rows: { key: string; label: string; value: number | null; shown: string }[];
  tone: ChartHue;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));

  return (
    <div className="space-y-2" data-adbar={id}>
      <style>{`
        [data-adbar="${id}"]{--adbar-${id}:${tone.light}}
        @media (prefers-color-scheme: dark){
          :root:not([data-theme="light"]) [data-adbar="${id}"]{--adbar-${id}:${tone.dark}}
        }
        :root[data-theme="dark"] [data-adbar="${id}"]{--adbar-${id}:${tone.dark}}
      `}</style>

      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>

      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2">
            <span className="truncate text-xs text-muted-foreground" title={r.label}>
              {r.label}
            </span>
            <span className="h-3 rounded-full bg-muted">
              {r.value === null || max <= 0 ? null : (
                <span
                  className="block h-3 rounded-full"
                  style={{
                    // A floor of 2%, so a real but tiny value is still a mark
                    // rather than nothing — "spent something" and "spent
                    // nothing" must not render identically.
                    width: `${Math.max(2, (r.value / max) * 100)}%`,
                    background: `var(--adbar-${id}, ${tone.light})`,
                  }}
                />
              )}
            </span>
            <span className="text-right text-xs tabular-nums">
              {r.value === null ? <span className="text-muted-foreground">{r.shown}</span> : r.shown}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdCompare({ ads }: { ads: AdPerf[] }) {
  // One ad is not a comparison, and a bar on its own is a full-width rectangle
  // that says nothing the number beside it did not.
  if (ads.length < 2) return null;

  const shown = ads.slice(0, MAX_BARS);
  const dropped = ads.length - shown.length;
  const currency = shown[0]?.currency || "INR";
  const rank = rankAds(ads);

  const spendRows = shown.map((a) => ({
    key: a.adId,
    label: a.name,
    value: a.spend,
    shown: money(a.spend, a.currency),
  }));

  /*
   * The second panel is whichever measure the verdict was actually made on, so
   * the chart and the "best"/"worst" badges in the table below cannot disagree.
   * When nothing could be judged there is no second panel — an empty frame is
   * not more honest than no frame.
   */
  const second =
    rank.by === "costPerLead"
      ? {
          id: "cpl",
          title: "Cost per lead",
          note: "Lower is better. An ad with no leads has no figure — it draws nothing.",
          tone: ADS.costPerLead,
          rows: shown.map((a) => ({
            key: a.adId,
            label: a.name,
            value: a.costPerLead,
            shown: a.costPerLead === null ? "no leads" : money(a.costPerLead, a.currency),
          })),
        }
      : rank.by === "ctr"
        ? {
            id: "ctr",
            title: "Click rate",
            note: "Higher is better. No ad has produced a lead yet, so this is what is left to compare.",
            tone: ADS.leads,
            rows: shown.map((a) => ({
              key: a.adId,
              label: a.name,
              value: a.ctr,
              shown: a.ctr === null ? "not shown yet" : `${a.ctr.toFixed(2)}%`,
            })),
          }
        : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ads compared</CardTitle>
        <p className="text-xs text-muted-foreground">
          {dropped > 0
            ? `The ${MAX_BARS} biggest spenders of ${ads.length}. ${dropped} smaller ${
                dropped === 1 ? "ad is" : "ads are"
              } in the table below.`
            : "Every ad that ran in this range."}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Panel
          id="spend"
          title={`Spent · ${money(
            shown.reduce((t, a) => t + a.spend, 0),
            currency
          )} across these`}
          note="Where the money went."
          rows={spendRows}
          tone={ADS.spend}
        />
        {second ? (
          <Panel
            id={second.id}
            title={second.title}
            note={second.note}
            rows={second.rows}
            tone={second.tone}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{rank.reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
