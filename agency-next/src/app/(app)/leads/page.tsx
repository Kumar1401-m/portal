import Link from "next/link";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import { ClientFilter } from "@/components/admin/client-filter";
import { Target, TriangleAlert, Flame, Trophy, IndianRupee } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES, ADMIN_ROLES } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { getLeads, leadsReady, funnel, LEAD_STAGES, type StageKey, isStage } from "@/lib/leads";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { money } from "@/lib/utils";
import { scoreLead } from "@/lib/lead-score";
import { LeadBoard } from "./lead-board";

export const metadata = { title: "Leads · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * Everything that has not signed yet.
 *
 * The rest of the portal begins the day a client signs. This is the month
 * before that — and it is the module with the clearest money attached to it,
 * because the enquiry nobody followed up on cost the agency a retainer.
 *
 * Admins and crm. Nobody who makes the work has any reason to be in here, and
 * a designer's nav is the honest list of what they can open.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; closed?: string; q?: string; client?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;

  if (!(await leadsReady())) {
    return (
      <div className="space-y-5">
        <Header />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <TriangleAlert className="h-8 w-8 text-warning" />
            <p className="font-medium">One step to switch this on</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The leads table isn&apos;t in this database yet. Open{" "}
              <span className="font-medium text-foreground">Settings → Database</span> and apply the
              pending changes — it adds a table and touches nothing existing.
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Go to Settings → Database
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const stage: StageKey | undefined = sp.stage && isStage(sp.stage) ? sp.stage : undefined;
  const includeClosed = sp.closed === "1" || Boolean(stage);

  /*
   * Which client's leads, and which clients this user may see at all.
   *
   * A lead exists because an ad ran for somebody. Unfiltered, the board is
   * every client's leads in one list — fine for a solo operator and useless
   * to an agency, where the question is always "what did this month get
   * *them*?". A crm sees only their own clients' leads either way.
   */
  const scope = await crmClientIds(user);
  const clients = await getClientsMini(scope);
  const wanted = Number(sp.client);
  const clientId =
    Number.isInteger(wanted) && clients.some((c) => c.id === wanted) ? wanted : null;

  const [leads, all, owners, todayRow] = await Promise.all([
    getLeads({ stage, includeClosed, search: sp.q, clientId, clientIds: scope }),
    // The header counts every lead, whatever the list is filtered to — a
    // filtered pipeline total is a number that changes when you click a tab,
    // which is the fastest way to make people stop trusting it.
    // The header counts this client's pipeline when one is picked, so the
    // total and the list are answering the same question.
    getLeads({ includeClosed: true, clientId, clientIds: scope }),
    query<{ id: number; name: string }>(
      `SELECT id, name FROM users
        WHERE role IN ('super_admin','admin','crm') AND COALESCE(is_active,1) = 1
        ORDER BY name`
    ),
    queryOne<{ today: string }>("SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today"),
  ]);

  const today = todayRow?.today ?? new Date().toISOString().slice(0, 10);
  const f = funnel(all, today);

  /*
   * Scored on the server, beside the rows themselves.
   *
   * Every point is a rule in lib/lead-score.ts rather than anything a model
   * produced — this decides who gets called back today, so it has to be
   * defensible line by line to whoever disagrees with it.
   */
  const scores = Object.fromEntries(leads.map((l) => [l.id, scoreLead(l, today)]));

  return (
    <div className="space-y-5">
      <Header>
        <ClientFilter
          clients={clients}
          current={clientId}
          basePath="/leads"
          keep={{ stage: sp.stage, closed: sp.closed, q: sp.q }}
        />
      </Header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Open leads"
          value={f.stages.filter((s) => s.key !== "won" && s.key !== "lost").reduce((t, s) => t + s.count, 0)}
          hint={`${money(f.openValue)} of monthly business in play`}
          icon={Target}
          tone="sky"
        />
        <StatCard
          title="Needs chasing"
          value={f.overdue + f.dueToday}
          hint={
            f.overdue
              ? `${f.overdue} overdue, ${f.dueToday} due today`
              : `${f.dueToday} due today, nothing overdue`
          }
          icon={Flame}
          tone={f.overdue ? "rose" : "emerald"}
        />
        <StatCard
          title="Conversion"
          value={f.conversion === null ? "—" : `${f.conversion.toFixed(0)}%`}
          hint="Of the leads that have closed, how many said yes"
          icon={Trophy}
          tone="orange"
        />
        <StatCard
          title="Won"
          value={money(f.wonValue)}
          hint="Monthly value signed, all time"
          icon={IndianRupee}
          tone="emerald"
        />
      </div>

      {/* The funnel itself: one chip per stage, each a filter. */}
      <div className="flex flex-wrap gap-2">
        <StageChip href="/leads" label="Open" count={f.stages.filter((s) => s.key !== "won" && s.key !== "lost").reduce((t, s) => t + s.count, 0)} active={!stage} />
        {LEAD_STAGES.map((s) => {
          const row = f.stages.find((x) => x.key === s.key);
          return (
            <StageChip
              key={s.key}
              href={`/leads?stage=${s.key}`}
              label={s.label}
              count={row?.count ?? 0}
              active={stage === s.key}
              title={s.hint}
            />
          );
        })}
      </div>

      <LeadBoard
        leads={leads}
        owners={owners}
        today={today}
        scores={scores}
        canDelete={ADMIN_ROLES.includes(user.role)}
      />
    </div>
  );
}

function StageChip({
  href,
  label,
  count,
  active,
  title,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </Link>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Target className="h-6 w-6 text-primary" /> Leads
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every enquiry, and who is chasing it — before it becomes a client.
        </p>
      </div>
      {children}
    </div>
  );
}
