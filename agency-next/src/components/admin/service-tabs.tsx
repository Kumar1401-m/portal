import Link from "next/link";
import { cn } from "@/lib/utils";
import { SERVICE_LIST, type ServiceKey } from "@/lib/services";
import type { ServiceCounts } from "@/lib/deliverables";

/**
 * The task-organisation tab bar: All Tasks · Videos · Posters · Website ·
 * Meta Ads · Content · Social. Picking a tab narrows the list to that service
 * only — no mixed task types.
 *
 * Plain links so the whole thing works without JS and stays bookmarkable.
 * Other active filters carry across; `category` is dropped because category
 * lists are service-specific.
 */
export function ServiceTabs({
  basePath,
  active,
  counts,
  params,
}: {
  basePath: string;
  active: ServiceKey | null;
  counts: ServiceCounts;
  params: Record<string, string>;
}) {
  const href = (service: ServiceKey | null) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v && k !== "service" && k !== "category") q.set(k, v);
    }
    if (service) q.set("service", service);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  const tabClass = (isActive: boolean, activeStyle: string) =>
    cn(
      "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
      isActive
        ? activeStyle
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card p-1.5">
      <Link
        href={href(null)}
        className={tabClass(
          active === null,
          "bg-primary text-primary-foreground ring-1 ring-inset ring-primary"
        )}
      >
        All Tasks
        <span className="rounded-full bg-black/10 px-1.5 text-xs tabular-nums dark:bg-white/15">
          {counts.all}
        </span>
      </Link>

      {SERVICE_LIST.map((s) => (
        <Link key={s.key} href={href(s.key)} className={tabClass(active === s.key, s.tab)}>
          <span className={cn("h-2 w-2 rounded-full", s.dot)} />
          {s.short}
          <span className="rounded-full bg-black/10 px-1.5 text-xs tabular-nums dark:bg-white/15">
            {counts[s.key]}
          </span>
        </Link>
      ))}
    </div>
  );
}
