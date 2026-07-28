import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SERVICE_LIST } from "@/lib/services";
import type { ServiceMixRow } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Workload by service — one colour-coded tile per service, each a shortcut into
 * that service's task tab. Keeps the dashboard consistent with the task tabs
 * instead of showing one undifferentiated pile.
 */
export function ServiceMix({ rows }: { rows: ServiceMixRow[] }) {
  const by = new Map(rows.map((r) => [r.service, r]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workload by service</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {SERVICE_LIST.map((s) => {
            const r = by.get(s.key);
            const open = r?.open ?? 0;
            const overdue = r?.overdue ?? 0;
            return (
              <Link
                key={s.key}
                href={`/deliverables?service=${s.key}`}
                className={cn(
                  "rounded-xl border p-4 transition-transform hover:-translate-y-0.5",
                  s.surface
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", s.dot)} />
                  {s.short}
                </span>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{open}</p>
                <p className="text-xs text-muted-foreground">
                  open
                  {overdue > 0 ? (
                    <span className="font-medium text-destructive"> · {overdue} overdue</span>
                  ) : null}
                </p>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
