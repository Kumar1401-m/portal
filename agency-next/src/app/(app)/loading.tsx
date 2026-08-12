/**
 * What a click looks like before the server has answered.
 *
 * Every page in this group is `force-dynamic`, so navigating to one means
 * waiting for a round trip to the database. Until now there was no
 * `loading.tsx` anywhere in the app, and the App Router's behaviour without
 * one is to keep showing the *old* page until the new payload arrives — so a
 * click produced no visible change at all for a few hundred milliseconds. The
 * portal was not slow so much as silent, and the honest reaction to a button
 * that does nothing is to press it again. Two to four times.
 *
 * A loading file fixes the cause rather than the appearance: Next can begin
 * the transition immediately and prefetch the route's static shell, so the
 * click lands the moment it is made.
 *
 * Shaped like the pages behind it — a heading, a row of cards, a table — so
 * the layout does not jump when the real content replaces it. Deliberately
 * plain: this is on screen for a few hundred milliseconds and anything
 * eye-catching would flash.
 */
function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="space-y-2">
        <Bar className="h-7 w-56" />
        <Bar className="h-4 w-80" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4">
            <Bar className="h-3.5 w-24" />
            <Bar className="mt-3 h-7 w-20" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <Bar className="h-4 w-40" />
        </div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0">
            <Bar className="h-4 w-6 shrink-0" />
            <Bar className="h-4 flex-1" />
            <Bar className="hidden h-4 w-24 sm:block" />
            <Bar className="hidden h-4 w-20 md:block" />
            <Bar className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
