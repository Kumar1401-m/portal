import Link from "next/link";
import { Users, AlarmClock, TriangleAlert } from "lucide-react";
import { query } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { workload, rankAssignees, deadlineRisk, dbToday, type Member } from "@/lib/team-ai";
import { fmtDate } from "@/lib/utils";

/**
 * Who is carrying what, and what is going to be late.
 *
 * Both answers come out of the same two facts — a person's open queue and how
 * long their work usually takes — so they are one panel rather than two
 * features. Nothing here is generated: a recommendation about a colleague's
 * workload has to be defensible to that colleague, and "the AI said so" is not
 * defensible.
 *
 * Only work is used. Queue length, stated capacity, past turnaround. Nothing
 * about who anybody is, because an assignment engine that learns from anything
 * else learns the team's existing biases and then enforces them at speed.
 */
export async function WorkloadPanel() {
  const [members, today] = await Promise.all([workload(), dbToday()]);
  if (!members.length) return null;

  /*
   * The tasks most likely to miss their date.
   *
   * Open work with a date, soonest first — the risk is computed per row below
   * against whoever holds it. Capped, because this is a "what do I do this
   * morning" list and a hundred rows is a report nobody reads.
   */
  const atRisk = await query<{
    id: number;
    title: string;
    due_date: string | null;
    assigned_to: number | null;
    company_name: string;
  }>(
    `SELECT d.id, d.title, d.due_date, d.assigned_to, c.company_name
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.status IN ('pending','waiting_for_raw','raw_uploaded','editing','changes_requested')
        AND d.due_date IS NOT NULL
        AND d.due_date <= CURDATE() + INTERVAL 14 DAY
      ORDER BY d.due_date ASC
      LIMIT 40`
  ).catch(() => []);

  const byId = new Map(members.map((m) => [m.id, m]));

  // Queue position per person, counted here rather than per row: one pass over
  // the same list gives every task how much of that person's work sits in
  // front of it.
  const ahead = new Map<number, number>();
  const seen = new Map<number, number>();
  for (const t of atRisk) {
    if (!t.assigned_to) {
      ahead.set(t.id, 0);
      continue;
    }
    const n = seen.get(t.assigned_to) ?? 0;
    ahead.set(t.id, n);
    seen.set(t.assigned_to, n + 1);
  }

  const risky = atRisk
    .map((t) => ({
      task: t,
      risk: deadlineRisk({
        dueDate: t.due_date,
        today,
        assignee: t.assigned_to ? (byId.get(t.assigned_to) ?? null) : null,
        aheadInQueue: ahead.get(t.id) ?? 0,
      }),
    }))
    .filter((r) => r.risk.band !== "safe")
    .sort((a, b) => b.risk.risk - a.risk.risk)
    .slice(0, 8);

  const editors = rankAssignees(members, "video_editor");
  const designers = rankAssignees(members, "poster_designer");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-muted-foreground" /> Who has room
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Open queue against each person&apos;s own stated pace. Whoever is freest, first.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 pb-6">
          {[
            { label: "Video editors", list: editors },
            { label: "Poster designers", list: designers },
          ]
            .filter((g) => g.list.length)
            .map((g) => (
              <div key={g.label}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </p>
                <div className="space-y-1.5">
                  {g.list.map((c, i) => (
                    <div
                      key={c.member.id}
                      className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 rounded-lg border border-border p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {c.member.name}
                          {i === 0 ? (
                            <span className="ml-1.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs font-normal text-emerald-700 dark:text-emerald-300">
                              give it to them
                            </span>
                          ) : null}
                        </p>
                        {/* The workings, not just the verdict. */}
                        <p className="text-xs text-muted-foreground">{c.reasons.join(" · ")}</p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">
                        {c.fit}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          <p className="text-xs text-muted-foreground">
            Turnaround is measured from when a task was created to when it was delivered, so it
            includes time before anybody picked it up. It is the only span the board records end to
            end, and it is consistent per person.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlarmClock className="h-4 w-4 text-muted-foreground" /> Going to be late
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Days left against the queue in front of it and how long that person&apos;s work usually
            takes.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 pb-6">
          {risky.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing due in the next fortnight looks at risk.
            </p>
          ) : (
            risky.map(({ task, risk }) => (
              <div
                key={task.id}
                className={`rounded-lg border p-2.5 ${
                  risk.band === "overdue" || risk.band === "likely_late"
                    ? "border-rose-500/40 bg-rose-500/5"
                    : "border-amber-500/40 bg-amber-500/5"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
                  <Link
                    href={`/deliverables/${task.id}`}
                    className="min-w-0 text-sm font-medium hover:text-primary hover:underline"
                  >
                    {task.title}
                  </Link>
                  <span className="shrink-0 text-xs font-semibold tabular-nums">
                    {risk.band === "overdue" ? "Overdue" : `${risk.risk}% risk`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {task.company_name} · due {fmtDate(task.due_date)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{risk.reasons.join(" · ")}</p>
                <p className="mt-1 text-xs">{risk.recommendation}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Shown when nobody has a capacity set — the panel needs one to say anything. */
export function NoCapacity({ members }: { members: Member[] }) {
  if (members.some((m) => m.capacityPerDay > 0)) return null;
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p>
          Nobody has a daily target set, so workload is counted in tasks rather than days and
          nobody is ranked on pace. Set one in{" "}
          <Link href="/settings" className="text-primary hover:underline">
            Settings → Team
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
