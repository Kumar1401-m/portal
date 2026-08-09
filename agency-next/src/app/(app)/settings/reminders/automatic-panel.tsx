import Link from "next/link";
import { CircleCheck, CircleSlash, Repeat, TriangleAlert, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type AutomaticStatus = {
  /** The five rules, and what each would send on the next run. */
  pending: { label: string; when: string; n: number }[];
  totalPending: number;
  /** Heartbeats. Null means the job has never reported in. */
  daily: { agoLabel: string; ok: boolean; summary: string | null; stale: boolean } | null;
  poll: { agoLabel: string; ok: boolean; summary: string | null; stale: boolean } | null;
  /** What actually went out over the last week. */
  sentThisWeek: { kind: string; label: string; n: number }[];
  weekTotal: number;
  unreachable: { id: number; company_name: string }[];
};

function Heartbeat({
  name,
  every,
  does,
  beat,
  missing,
}: {
  name: string;
  every: string;
  does: string;
  beat: AutomaticStatus["daily"];
  /** What to say, and what to do, when it has never reported in. */
  missing: string;
}) {
  const state = !beat ? "never" : beat.stale ? "stale" : beat.ok ? "ok" : "error";
  const Icon = state === "ok" ? CircleCheck : state === "never" ? CircleSlash : TriangleAlert;

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        state === "ok" && "border-success/40 bg-success/5",
        state === "stale" && "border-warning/40 bg-warning/5",
        state === "error" && "border-destructive/30 bg-destructive/5",
        state === "never" && "border-border bg-muted/30"
      )}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            state === "ok" && "text-success",
            state === "stale" && "text-warning",
            state === "error" && "text-destructive",
            state === "never" && "text-muted-foreground"
          )}
        />
        {name}
        <span className="font-normal text-muted-foreground">· {every}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{does}</p>

      {beat ? (
        <p className="mt-2 text-xs">
          <span className={cn("font-medium", state === "stale" && "text-warning")}>
            Last ran {beat.agoLabel}
          </span>
          {beat.summary ? <span className="text-muted-foreground"> — {beat.summary}</span> : null}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Never run.</span> {missing}
        </p>
      )}

      {beat?.stale ? (
        <p className="mt-1 text-xs text-muted-foreground">
          That is longer ago than it should be — check the workflow is still published in n8n.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the reminders are going out on their own.
 *
 * The question this page kept getting was simply "does it actually send by
 * itself?", and nothing on screen could answer it. An empty list of sent
 * reminders has two opposite meanings — nothing was due, or nothing is
 * running — so the answer needs three facts side by side: when each job last
 * reported in, what the next run would send, and what actually went out.
 *
 * The pending numbers are not an estimate. They come from the same queries the
 * run itself uses, stopped one step before WhatsApp.
 */
export function AutomaticPanel({ status }: { status: AutomaticStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Repeat className="h-5 w-5 text-primary" /> Sent automatically
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          These go out on their own. You don&apos;t need to touch anything above for them to work.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Heartbeat
            name="The daily chases"
            every="10:00 every morning"
            does="Approvals after 12h, auto-approve after 24h, footage 3 days out, the month's plan, unpaid invoices."
            beat={status.daily}
            missing="Import n8n/workflows/whatsapp-reminders.json and publish it."
          />
          <Heartbeat
            name="The scheduled queue"
            every="every 5 minutes"
            does="Sends whatever you scheduled above, at the time you set."
            beat={status.poll}
            missing="Import n8n/workflows/whatsapp-outbox.json and publish it — without it, a time you set won't be kept."
          />
        </div>

        {/* What the next run would do — the other half of the answer. */}
        <div className="rounded-lg border border-border p-3">
          <p className="text-sm font-medium">
            Waiting for the next daily run:{" "}
            <span className="tabular-nums">{status.totalPending}</span>
          </p>
          {status.totalPending === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing is due. Zero here with a recent run above means it is working and there is
              simply nothing to chase — not that it is switched off.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {status.pending
                .filter((p) => p.n > 0)
                .map((p) => (
                  <li key={p.label} className="flex items-baseline gap-2 text-xs">
                    <span className="w-6 shrink-0 text-right font-medium tabular-nums">{p.n}</span>
                    <span>{p.label}</span>
                    <span className="text-muted-foreground">· {p.when}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-sm font-medium">
            Sent automatically in the last 7 days:{" "}
            <span className="tabular-nums">{status.weekTotal}</span>
          </p>
          {status.weekTotal === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing yet. Reminders only fire when something is actually overdue.
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {status.sentThisWeek.map((s) => (
                <li key={s.kind} className="text-xs">
                  <span className="font-medium tabular-nums">{s.n}</span>{" "}
                  <span className="text-muted-foreground">{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Every rule joins through whatsapp_groups, so these clients are
            skipped by all of them — silently, unless it is said here. */}
        {status.unreachable.length > 0 ? (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 shrink-0 text-warning" />
              {status.unreachable.length} client
              {status.unreachable.length === 1 ? "" : "s"} will never get any of these
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              No WhatsApp group is linked, so every reminder skips them —{" "}
              {status.unreachable.map((c) => c.company_name).join(", ")}.{" "}
              <Link href="/settings/whatsapp" className="text-primary hover:underline">
                Link their groups
              </Link>
              .
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
