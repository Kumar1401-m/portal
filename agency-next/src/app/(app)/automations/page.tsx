import Link from "next/link";
import {
  Workflow,
  Bot,
  Hand,
  ChevronRight,
  CircleDot,
  Sparkles,
  Wrench,
  TriangleAlert,
  CheckCircle2,
} from "lucide-react";
import { publishBlockers } from "@/lib/instagram";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import {
  NODES,
  EDGES,
  liveCounts,
  jobStatuses,
  HEALTH_TEXT,
  AI_STEPS,
  whyLate,
  type Health,
  type NodeKey,
} from "@/lib/automation-map";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { prettyLocal } from "@/lib/posting";
import { RunNow } from "./run-buttons";

export const metadata = { title: "Automations · NVK Hub" };
export const dynamic = "force-dynamic";

/** The stages along the main line, in order. The other two are branches off it. */
const MAIN: NodeKey[] = ["planned", "footage", "editing", "with_client", "ready", "posted"];
const BRANCHES: NodeKey[] = ["changes", "failed"];

const NODE_TONE: Record<string, string> = {
  muted: "border-border",
  amber: "border-amber-500/50 bg-amber-500/5",
  sky: "border-sky-500/50 bg-sky-500/5",
  violet: "border-violet-500/50 bg-violet-500/5",
  emerald: "border-emerald-500/50 bg-emerald-500/5",
  rose: "border-rose-500/50 bg-rose-500/5",
};

const HEALTH_TONE: Record<Health, "success" | "warning" | "danger" | "muted"> = {
  ok: "success",
  late: "warning",
  failing: "danger",
  never: "muted",
};

/**
 * The machine, with the lid off.
 *
 * Everything here already ran; none of it was visible. The map is the whole
 * point — where work is sitting right now, what moves it on, and whether the
 * thing that does the moving is still alive.
 *
 * Admins only. It is a view of the whole agency's pipeline and it carries
 * buttons that reach clients.
 */
export default async function AutomationsPage() {
  await requireUser(ADMIN_ROLES);

  // The clock is read inside `jobStatuses` — a component may not call
  // `Date.now()` during render, and "overdue" must not change on a re-render.
  const [counts, jobs, blockers] = await Promise.all([
    liveCounts(),
    jobStatuses(),
    /*
     * Why nothing is going out, which the heartbeats above cannot say.
     *
     * A run that finds nothing due reports success and looks perfectly
     * healthy — because from its own point of view it is. Everything that
     * stops a post is a condition the queue simply filters on, so the work
     * disappears silently and the only symptom is a client noticing their
     * feed went quiet.
     */
    publishBlockers().catch(() => []),
  ]);

  const node = (key: NodeKey) => NODES.find((n) => n.key === key)!;
  const automated = EDGES.filter((e) => e.automated).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Workflow className="h-6 w-6 text-primary" /> Automations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where the work is sitting, what moves it on, and whether that is still running.
        </p>
      </div>

      {/*
        First on the page, above the pipeline, because it is the answer to the
        question somebody opens this page with.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {blockers.length ? (
              <TriangleAlert className="h-4 w-4 text-warning" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-success" />
            )}
            Why work is not going out
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Approved work the publisher will pass over, and the reason. A run with nothing to do
            reports success — so an empty queue and a broken setup look identical from the
            heartbeats below.
          </p>
        </CardHeader>
        <CardContent>
          {blockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is stuck. Everything approved either has its slot and is waiting for it, or
              has already gone out.
            </p>
          ) : (
            <div className="space-y-3">
              {blockers.map((b) => (
                <div key={b.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium">{b.reason}</p>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">
                      {b.count} {b.count === 1 ? "task" : "tasks"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{b.fix}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {b.examples.map((e) => (
                      <Link
                        key={e.id}
                        href={`/deliverables/${e.id}`}
                        className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
                      >
                        {e.company} — {e.title}
                      </Link>
                    ))}
                    {b.count > b.examples.length ? (
                      <span className="text-xs text-muted-foreground">
                        +{b.count - b.examples.length} more
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The pipeline, right now</CardTitle>
          <p className="text-xs text-muted-foreground">
            {automated} of the {EDGES.length} steps happen without anybody pressing anything. Every
            box is a link to the work inside it.
          </p>
        </CardHeader>
        <CardContent className="pb-6">
          {/* Scrolls sideways inside its own box on a phone rather than
              pushing the page wide. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-2">
            <div className="flex min-w-max items-stretch gap-1">
              {MAIN.map((key, i) => (
                <div key={key} className="flex items-stretch gap-1">
                  <FlowBox nodeKey={key} count={counts[key]} node={node(key)} />
                  {i < MAIN.length - 1 ? (
                    <ChevronRight className="my-auto h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {BRANCHES.map((key) => (
              <Link
                key={key}
                href={node(key).href}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 ${
                  NODE_TONE[node(key).tone]
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{node(key).label}</p>
                  <p className="truncate text-xs text-muted-foreground">{node(key).hint}</p>
                </div>
                <span className="shrink-0 text-2xl font-semibold tabular-nums">{counts[key]}</span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What moves it</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 pb-6">
            {EDGES.map((e, i) => (
              <div key={i} className="flex items-start gap-2.5 text-sm">
                {e.automated ? (
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Hand className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0">
                  <p>{e.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {node(e.from).label} → {node(e.to).label}
                    <span className="ml-1.5">{e.automated ? "· automatic" : "· a person does this"}</span>
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scheduled jobs</CardTitle>
            <p className="text-xs text-muted-foreground">
              A job is only marked overdue after it has missed twice — a nightly job checked at
              five past midnight has not failed.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pb-6">
            {jobs.map((j) => (
              <div
                key={j.key}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <CircleDot
                      className={`h-3 w-3 shrink-0 ${
                        j.health === "ok"
                          ? "text-emerald-500"
                          : j.health === "late"
                            ? "text-amber-500"
                            : j.health === "failing"
                              ? "text-destructive"
                              : "text-muted-foreground"
                      }`}
                      aria-hidden
                    />
                    {j.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{j.hint}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {j.run?.ran_at ? `Last ran ${prettyLocal(j.run.ran_at)}` : "No run recorded yet"}
                    {j.run?.summary ? ` — ${j.run.summary}` : ""}
                  </p>
                  {/*
                    What to actually do about it.

                    "Overdue" names the symptom and stops, which is how a red
                    badge sits on a page for a month. The cause has never yet
                    been in this codebase — it is that nothing is calling the
                    endpoint often enough — and that is not a thing anybody
                    guesses from the word "Overdue".
                  */}
                  {whyLate(j.key, j.health) ? (
                    <p className="mt-1 flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
                      <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{whyLate(j.key, j.health)}</span>
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* The badge carries the word, not just the colour. */}
                  <Badge tone={HEALTH_TONE[j.health]}>{HEALTH_TEXT[j.health]}</Badge>
                  {j.key === "publishing" ? (
                    <RunNow job="publishing" label="Published what was due" />
                  ) : null}
                  {j.key === "insights_sync" ? (
                    <RunNow job="insights_sync" label="Read from Instagram" />
                  ) : null}
                  {j.key === "monthly_reports" ? (
                    <RunNow job="monthly_reports" label="Reports queued" />
                  ) : null}
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              The WhatsApp jobs are driven by n8n and the message service. Their reminders are sent
              and scheduled from{" "}
              <Link href="/settings/reminders" className="text-primary hover:underline">
                Settings → Reminders
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>

      {/*
        What the AI does, written down.

        The calls are scattered across a dozen modules; some fire on a
        schedule, some when a button is pressed, and none of them announce
        themselves — so "AI" had become a word meaning something unspecified
        was happening somewhere. Only real call sites are listed: a list that
        flattered the portal would cost the credibility of the rest of it the
        first time somebody went looking for one.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            What the AI does
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Every place a model is used, in the order work meets them. Nothing else in the portal
            calls one.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {AI_STEPS.map((step) => (
            <Link
              key={step.label}
              href={step.href}
              className="rounded-lg border border-border p-3 transition-colors hover:bg-muted/50"
            >
              <p className="text-sm font-medium">{step.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{step.does}</p>
              <p className="mt-1.5 text-xs text-muted-foreground/80">{step.when}</p>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function FlowBox({
  nodeKey,
  count,
  node,
}: {
  nodeKey: NodeKey;
  count: number;
  node: (typeof NODES)[number];
}) {
  return (
    <Link
      href={node.href}
      className={`flex w-36 flex-col justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50 ${
        NODE_TONE[node.tone]
      }`}
      title={node.hint}
      key={nodeKey}
    >
      <p className="text-xs font-medium leading-tight">{node.label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{count}</p>
    </Link>
  );
}
