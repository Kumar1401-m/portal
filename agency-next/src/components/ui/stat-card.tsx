import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

/** "orange" is the brand tone; the rest stay semantic (success, risk, info). */
type Tone = "orange" | "emerald" | "amber" | "rose" | "sky" | "indigo" | "violet";

const toneStyles: Record<Tone, { ring: string; icon: string }> = {
  orange: { ring: "from-orange-500/15 to-orange-500/5", icon: "bg-orange-500/15 text-orange-600 dark:text-orange-300" },
  emerald: { ring: "from-emerald-500/15 to-emerald-500/5", icon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" },
  amber: { ring: "from-amber-500/15 to-amber-500/5", icon: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  rose: { ring: "from-rose-500/15 to-rose-500/5", icon: "bg-rose-500/15 text-rose-600 dark:text-rose-300" },
  sky: { ring: "from-sky-500/15 to-sky-500/5", icon: "bg-sky-500/15 text-sky-600 dark:text-sky-300" },
  // Legacy aliases — both now render in the brand orange family.
  indigo: { ring: "from-orange-500/15 to-orange-500/5", icon: "bg-orange-500/15 text-orange-600 dark:text-orange-300" },
  violet: { ring: "from-amber-500/15 to-amber-500/5", icon: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
};

export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  tone = "indigo",
  className,
}: {
  title: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  const t = toneStyles[tone];
  return (
    <Card className={cn("interactive relative overflow-hidden", className)}>
      <div
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br",
          t.ring
        )}
      />
      <div className="relative flex items-start justify-between p-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          {hint ? (
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        {Icon ? (
          <div className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", t.icon)}>
            <Icon className="h-5 w-5" />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
