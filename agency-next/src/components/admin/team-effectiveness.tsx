import Link from "next/link";
import { Gauge, CheckCircle2, AlertTriangle } from "lucide-react";
import { teamEffectiveness } from "@/lib/effectiveness";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { label } from "@/lib/utils";

/**
 * Who hit today's target and who did not.
 *
 * On the super admin's dashboard rather than a page of its own, because the
 * question it answers — "is today going to plan" — is the one that dashboard
 * exists for, and a board nobody passes is a board nobody reads.
 *
 * Three things it deliberately does not do. It does not rank people: the rows
 * are alphabetical, and someone with no target sinks to the bottom because
 * there is nothing to say about them, not because they are worst. It does not
 * colour a missed target red — amber, because a target is a plan and missing
 * one by lunchtime is normal. And it says out loud what it is counting, since
 * a number without its definition invites an argument that the number cannot
 * settle.
 */
export async function TeamEffectiveness() {
  const data = await teamEffectiveness();
  if (!data.ready) return null;

  const t = data.totals;
  const noTargets = t.withTarget === 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-5 w-5 text-primary" />
            Team effectiveness
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {noTargets ? (
              <>No daily targets set yet — set one per person in Settings → Team.</>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {t.onTarget} of {t.withTarget}
                </span>{" "}
                on target today · {t.done} finished against {t.target} asked for
              </>
            )}
          </p>
        </div>
        <Link href="/settings" className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Set targets
        </Link>
      </CardHeader>

      <CardContent className="p-0">
        <Table dense>
          <THead>
            <tr>
              <th>Member</th>
              <th className="text-right">Target</th>
              <th className="text-right">Done today</th>
              <th className="text-right">Open</th>
              <th className="text-right">Overdue</th>
              <th className="text-right">Today</th>
            </tr>
          </THead>
          <TBody>
            {data.members.map((m) => (
              <TR key={m.id}>
                <TD>
                  <span className="font-medium">{m.name}</span>
                  <div className="text-xs text-muted-foreground">{label(m.role)}</div>
                </TD>
                <TD className="text-right tabular-nums">
                  {m.target > 0 ? m.target : <span className="text-muted-foreground">—</span>}
                </TD>
                <TD className="text-right font-medium tabular-nums">{m.done}</TD>
                <TD className="text-right tabular-nums text-muted-foreground">{m.open}</TD>
                <TD className="text-right tabular-nums">
                  {m.overdue > 0 ? (
                    <span className="font-medium text-destructive">{m.overdue}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TD>
                {/*
                  No target means no verdict. Showing "0 of 0 — achieved" would
                  be a green tick for having been forgotten.
                */}
                <TD className="text-right">
                  {m.hit === null ? (
                    <span className="text-xs text-muted-foreground">No target</span>
                  ) : m.hit ? (
                    <Badge tone="success">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Achieved
                    </Badge>
                  ) : (
                    <Badge tone="warning">
                      <AlertTriangle className="mr-1 h-3 w-3" />
                      {m.target - m.done} to go
                    </Badge>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        {/* The definition, next to the numbers rather than in someone's head.
            `updated_at` is the closest the schema has to "when it moved", and
            an unrelated edit touches it too — better said than implied. */}
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          &ldquo;Done today&rdquo; counts tasks assigned to that person which reached editing
          hand-off, review, approval or posting today. Resets at midnight.
        </p>
      </CardContent>
    </Card>
  );
}
