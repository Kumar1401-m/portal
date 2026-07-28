import { cn } from "@/lib/utils";
import { serviceDef, SERVICES, type ServiceKey } from "@/lib/services";

type TaskLike = { service?: string | null; video_type?: string | null };

/**
 * The colour-coded service chip. Used everywhere a task is shown — lists,
 * cards, detail headers, the portal — so a task's service reads the same way
 * at a glance across the whole portal.
 */
export function ServiceBadge({
  task,
  category,
  className,
  showCategory = true,
}: {
  task: TaskLike;
  category?: string | null;
  className?: string;
  showCategory?: boolean;
}) {
  const s = serviceDef(task);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
          s.chip
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
        {s.short}
      </span>
      {showCategory && category ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground whitespace-nowrap">
          {category}
        </span>
      ) : null}
    </span>
  );
}

/** Just the coloured dot — for dense rows and notification items. */
export function ServiceDot({
  task,
  className,
}: {
  task: TaskLike;
  className?: string;
}) {
  const s = serviceDef(task);
  return (
    <span
      title={s.label}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", s.dot, className)}
    />
  );
}

/** A chip driven by an explicit key (for legends and the client services list). */
export function ServiceChip({
  service,
  className,
  count,
}: {
  service: ServiceKey;
  className?: string;
  count?: number;
}) {
  const s = SERVICES[service];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        s.chip,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
      {typeof count === "number" ? (
        <span className="tabular-nums opacity-70">{count}</span>
      ) : null}
    </span>
  );
}
