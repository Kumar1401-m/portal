import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

type Tone = "indigo" | "emerald" | "amber" | "rose" | "sky" | "violet";

const toneStyles: Record<Tone, { ring: string; icon: string }> = {
  indigo: { ring: "from-indigo-500/15 to-indigo-500/5", icon: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300" },
  emerald: { ring: "from-emerald-500/15 to-emerald-500/5", icon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" },
  amber: { ring: "from-amber-500/15 to-amber-500/5", icon: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  rose: { ring: "from-rose-500/15 to-rose-500/5", icon: "bg-rose-500/15 text-rose-600 dark:text-rose-300" },
  sky: { ring: "from-sky-500/15 to-sky-500/5", icon: "bg-sky-500/15 text-sky-600 dark:text-sky-300" },
  violet: { ring: "from-violet-500/15 to-violet-500/5", icon: "bg-violet-500/15 text-violet-600 dark:text-violet-300" },
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
