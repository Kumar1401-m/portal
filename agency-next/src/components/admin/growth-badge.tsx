import { ArrowDownRight, ArrowUpRight, Minus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Period-over-period change.
 *
 * Four states, not two, because "up or down" isn't the whole truth:
 *
 *   null  — there was no baseline to compare against. Shown as "new", never as
 *           an infinite percentage, which is what a naive (now − 0) / 0 gives.
 *   0     — genuinely unchanged.
 *   ±n    — a real move.
 *
 * The arrow icon carries the direction alongside the colour, so the meaning
 * survives colour-vision deficiency, greyscale printing and forced-colors mode.
 *
 * `inverse` is for metrics where down is good (cost per result, unfollows).
 * Nothing on the dashboard uses it yet; it exists so the first metric that
 * needs it doesn't get a hand-rolled second badge.
 */
export function GrowthBadge({
  value,
  inverse = false,
  className,
}: {
  value: number | null;
  inverse?: boolean;
  className?: string;
}) {
  if (value === null) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300",
          className
        )}
      >
        <Sparkles className="h-3 w-3" aria-hidden /> new
      </span>
    );
  }

  if (value === 0) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground",
          className
        )}
      >
        <Minus className="h-3 w-3" aria-hidden /> no change
      </span>
    );
  }

  const rising = value > 0;
  const good = inverse ? !rising : rising;
  const Icon = rising ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        good
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-rose-500/10 text-rose-700 dark:text-rose-300",
        className
      )}
      title={`${rising ? "Up" : "Down"} ${Math.abs(value).toFixed(1)}% vs the previous period`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}
