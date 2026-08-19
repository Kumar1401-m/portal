import { TrendingUp, TrendingDown, CircleDashed } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { learned, nextFormat, MIN_POSTS, type Learned } from "@/lib/learning";

/**
 * The loop, on screen.
 *
 * Everything the studio writes is now weighted by this — the same numbers go
 * into the brief behind every generation. Showing them is what makes that
 * checkable rather than a claim: an agency told "your myths reels do 2.4× your
 * average" can look at the row and count the posts it was measured from.
 *
 * Deliberately a table of what was measured, not a verdict. The verdict is one
 * line at the top, and it says how sure it is.
 */
export async function LearnedPanel({ clientId }: { clientId: number }) {
  const l = await learned(clientId).catch(() => null);
  if (!l) return null;
  return <LearnedBoard l={l} />;
}

export function LearnedBoard({ l }: { l: Learned }) {
  const next = nextFormat(l);
  const proven = l.formats.filter((f) => f.proven);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">What we have learned</h3>
          <p className="text-xs text-muted-foreground">
            {l.measured} of {l.total} published posts in the last {l.months} months can be traced
            back to a format we chose
          </p>
        </div>

        {l.formats.length === 0 ? (
          /*
           * Not an error, and not empty either — it is the loop's first turn.
           * Every task created from an idea or a poster draft from here on
           * records its format, and results start arriving as those go out.
           */
          <p className="text-sm text-muted-foreground">
            Nothing to learn from yet. From now on, every idea turned into a task and every poster
            drafted here records which format it was — once {MIN_POSTS} posts of a format have been
            published and synced, this fills in and the studio starts weighting its advice by it.
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1 font-semibold">Format</th>
                  <th className="pb-1 text-right font-semibold">Posts</th>
                  <th className="pb-1 text-right font-semibold">Reach</th>
                  <th className="pb-1 text-right font-semibold">Engaged</th>
                  <th className="pb-1 text-right font-semibold">vs average</th>
                  <th className="pb-1 text-right font-semibold">Sure</th>
                </tr>
              </thead>
              <tbody>
                {l.formats.map((f) => (
                  <tr key={f.key} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5">
                      <span className="flex items-center gap-1.5">
                        {!f.proven ? (
                          <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : f.lift >= 1.15 ? (
                          <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
                        ) : f.lift <= 0.85 ? (
                          <TrendingDown className="h-3.5 w-3.5 text-amber-600" />
                        ) : (
                          <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {f.label}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{f.posts}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {f.avgReach.toLocaleString("en-IN")}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {f.avgEngagement.toFixed(1)}%
                    </td>
                    {/* The whole point of the row. A format is only better or
                        worse than this account's own typical post. */}
                    <td className="py-1.5 text-right tabular-nums font-medium">
                      {f.proven ? `${f.lift.toFixed(1)}×` : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {f.proven ? `${f.confidence}%` : `needs ${MIN_POSTS - f.posts} more`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-xs text-muted-foreground">
              Engagement is measured against this account&apos;s own average of{" "}
              {l.baseline.toFixed(1)}%. A format with fewer than {MIN_POSTS} posts gets no verdict —
              two good posts are two good posts, not a pattern.
            </p>
          </>
        )}

        {next ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm">
              <span className="font-medium">Make next: {next.label}</span>{" "}
              <span className="text-muted-foreground">— {next.why}</span>
            </p>
            {!proven.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing is proven yet, so this is a way to find out rather than a recommendation.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
