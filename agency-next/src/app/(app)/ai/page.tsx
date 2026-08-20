import Link from "next/link";
import {
  Sparkles,
  TriangleAlert,
  Lightbulb,
  CircleAlert,
  CircleCheck,
  HeartPulse,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES, ADMIN_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import { getInsights, healthBoard, insightsReady } from "@/lib/ai-insights";
import {
  ENGINES,
  disabledEngines,
  modelConfigured,
  stateOf,
  STATE_TEXT,
} from "@/lib/ai-engines";
import type { Severity } from "@/lib/brain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { prettyLocal } from "@/lib/posting";
import { RefreshInsights, AskBrain, EngineList, NightShift, type EngineRow } from "./panels";
import { BusinessAdvisor } from "./advisor";

export const metadata = { title: "AI · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * The AI dashboard.
 *
 * Problem → data → recommendation → action, on every card. That shape is the
 * whole point: a dashboard that says "engagement is down" is a dashboard
 * somebody has to go and investigate, which is the work it was supposed to
 * save.
 *
 * Nothing here is generated prose. Every figure on this page was computed from
 * the client's own rows in `lib/brain.ts`; the model's only job anywhere in
 * this feature is wording the answer in "Ask the Brain", and even that falls
 * back to a plain sentence built from the same numbers.
 */

const TONE: Record<Severity, { ring: string; chip: string; Icon: typeof CircleAlert }> = {
  critical: {
    ring: "border-l-4 border-l-rose-500",
    chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    Icon: CircleAlert,
  },
  warning: {
    ring: "border-l-4 border-l-amber-500",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    Icon: TriangleAlert,
  },
  opportunity: {
    ring: "border-l-4 border-l-violet-500",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    Icon: Lightbulb,
  },
  good: {
    ring: "border-l-4 border-l-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    Icon: CircleCheck,
  },
};

const SEVERITY_WORD: Record<Severity, string> = {
  critical: "Critical",
  warning: "Needs attention",
  opportunity: "Opportunity",
  good: "Working",
};

export default async function AiPage() {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const scope = await crmClientIds(user);

  if (!(await insightsReady())) {
    return (
      <div className="space-y-5">
        <Header />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <TriangleAlert className="h-8 w-8 text-warning" />
            <p className="font-medium">One step to switch this on</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The findings are stored in a table this database doesn&apos;t have yet. Open{" "}
              <span className="font-medium text-foreground">Settings → Database</span> and apply the
              pending changes.
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Go to Settings → Database
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const [insights, health, clients, off] = await Promise.all([
    getInsights(scope),
    healthBoard(scope),
    getClientsMini(scope),
    disabledEngines(),
  ]);

  const engines: EngineRow[] = ENGINES.map((e) => {
    const on = !off.has(e.key);
    const state = stateOf(e, { enabled: on });
    return {
      key: e.key,
      label: e.label,
      purpose: e.purpose,
      module: e.module,
      state,
      stateText: STATE_TEXT[state],
      on,
      built: e.built,
    };
  });

  const critical = insights.filter((i) => i.severity === "critical").length;
  const opportunities = insights.filter((i) => i.severity === "opportunity").length;
  const atRisk = health.filter((h) => h.band !== "healthy").length;
  const lastRun = insights[0]?.generatedAt ?? null;
  const isAdmin = ADMIN_ROLES.includes(user.role);

  return (
    <div className="space-y-5">
      <Header>
        <RefreshInsights />
      </Header>

      {/*
        The part that comes and finds you.
        
        Everything else on this page waits to be opened. This decides what
        actually needs somebody and puts it in the notification bell, so the
        answer to "is anything wrong" arrives without the question being asked.
      */}
      {isAdmin ? (
        <Card>
          <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">The night shift</p>
              <p className="text-sm text-muted-foreground">
                Once a night it reads the money, the board, the Brain&apos;s findings and what the
                loop has proven, decides the few things that need you, and puts them in your
                notifications. Run it now to see what it would send.
              </p>
            </div>
            <NightShift />
          </CardContent>
        </Card>
      ) : null}

      {!modelConfigured() ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              No model key is set, so nothing here is written by AI — the findings below are still
              real, because every figure in them is computed from your own data. Add{" "}
              <span className="font-mono text-xs">GEMINI_API_KEY</span> to have the Brain word its
              answers too.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Needs attention now"
          value={critical}
          hint={critical ? "Ranked at the top of the list" : "Nothing critical today"}
          icon={CircleAlert}
          tone={critical ? "rose" : "emerald"}
        />
        <StatCard
          title="Opportunities"
          value={opportunities}
          hint="Things working that could be done more of"
          icon={Lightbulb}
          tone="violet"
        />
        <StatCard
          title="Clients off green"
          value={atRisk}
          hint={`of ${health.length} scored`}
          icon={HeartPulse}
          tone={atRisk ? "amber" : "emerald"}
        />
        <StatCard
          title="Findings on the board"
          value={insights.length}
          hint={lastRun ? `Last looked ${prettyLocal(lastRun)}` : "Press Re-run analysis"}
          icon={Sparkles}
          tone="sky"
        />
      </div>

      {clients.length ? <AskBrain clients={clients} /> : null}

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What the Brain found
        </h2>

        {insights.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">Nothing on the board</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Either everything is running as it should, or the analysis hasn&apos;t been run yet.
                Press <span className="font-medium text-foreground">Re-run analysis</span> — it
                needs a couple of months of published posts behind it to say anything useful.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {insights.map((i) => {
              const tone = TONE[i.severity];
              return (
                <Card key={`${i.clientId}-${i.kind}`} className={tone.ring}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 font-medium">
                          <tone.Icon className="h-4 w-4 shrink-0" aria-hidden />
                          {i.headline}
                        </p>
                        <Link
                          href={`/clients/${i.clientId}`}
                          className="text-xs text-muted-foreground hover:text-primary hover:underline"
                        >
                          {i.client}
                        </Link>
                      </div>
                      {/* The word, not only the colour. */}
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}>
                        {SEVERITY_WORD[i.severity]}
                      </span>
                    </div>

                    {i.evidence.length ? (
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        {i.evidence.map((line, idx) => (
                          <li key={idx} className="tabular-nums">
                            · {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {i.reason ? <p className="text-sm">{i.reason}</p> : null}

                    {i.recommendation ? (
                      <p className="text-sm">
                        <span className="font-medium">Do this: </span>
                        {i.recommendation}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {/* Confidence is derived from how much evidence sits behind
                          the finding, never asked of a model. */}
                      <span className="text-xs text-muted-foreground">
                        Confidence {i.confidence}% — from {i.evidence.length} measured figure
                        {i.evidence.length === 1 ? "" : "s"}
                      </span>
                      {i.action ? (
                        <Link
                          href={i.action.href}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          {i.action.label}
                        </Link>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {health.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client health</CardTitle>
            <p className="text-xs text-muted-foreground">
              Out of 100, worst first. Every deduction is listed — a score nobody can read is a
              score people argue with.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pb-6">
            {health.map((h) => (
              <div key={h.clientId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-border pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <Link href={`/clients/${h.clientId}`} className="font-medium hover:text-primary hover:underline">
                    {h.client}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {h.reasons.length
                      ? h.reasons.map((r) => `${r.delta > 0 ? "+" : ""}${r.delta} ${r.label}`).join(" · ")
                      : "Nothing against them this month"}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums ${
                    h.band === "healthy"
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : h.band === "attention"
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                  }`}
                >
                  {h.score}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* The book, not a client. Admins only, and behind a button because it
          is read once a month rather than on every visit. */}
      {ADMIN_ROLES.includes(user.role) ? <BusinessAdvisor /> : null}

      <EngineList engines={engines} canToggle={ADMIN_ROLES.includes(user.role)} />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="h-6 w-6 text-violet-600 dark:text-violet-400" /> AI
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What changed, why, and what to do about it — computed from your own data.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
