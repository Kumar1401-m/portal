import Link from "next/link";
import {
  Briefcase,
  Users,
  CheckCircle2,
  Hourglass,
  PencilLine,
  ListTodo,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getMyWork, myMonths, awaitingAdminReview } from "@/lib/my-work";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { MonthPicker } from "./month-picker";
import { contentStatusLabel, editorStatusLabel, editorStatusTone } from "@/lib/constants";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "My work · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * One screen for the people who make the work.
 *
 * An editor or designer could open the board they work on and nothing else:
 * how many clients they were carrying, how much of the month was done, and
 * what was sitting with the super admin were all questions they had to ask
 * somebody. This answers them without giving away anything that is not theirs
 * — every number comes from tasks assigned to them.
 *
 * Ordered by what they need soonest: what is overdue, what to pick up next,
 * then the month by client, then the work they have handed on and can only
 * wait for.
 */
export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser(["poster_designer", "video_editor", "super_admin", "admin"]);
  const sp = await searchParams;

  const months = await myMonths(user);
  const month = sp.month && months.includes(sp.month) ? sp.month : months[0];
  const [work, waiting] = await Promise.all([
    getMyWork(user, month),
    awaitingAdminReview(user),
  ]);
  const s = work.stats;

  const isDesigner = user.role === "poster_designer";
  const nothingAssigned = s.assigned === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Briefcase className="h-6 w-6 text-primary" />
            My work
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything assigned to you{isDesigner ? " to design" : " to edit"}, and where it has
            got to.
          </p>
        </div>
        <MonthPicker months={months} current={month} />
      </div>

      {/* The month, at a glance. Overdue first — it is the only one that is
          about right now rather than about the month as a whole. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Clients you're on"
          value={s.clients}
          icon={Users}
          tone="indigo"
        />
        <StatCard
          title="Finished"
          value={`${s.done} of ${s.assigned}`}
          icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          title="Still to do"
          value={s.toDo}
          icon={ListTodo}
          tone="amber"
        />
        <StatCard
          title="Overdue"
          value={s.overdue}
          icon={AlertTriangle}
          tone={s.overdue > 0 ? "rose" : "sky"}
        />
      </div>

      {/* Where the rest of it sits — and with whom, which is the part that was
          never visible from here. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          title="With the super admin"
          value={s.withAdmin}
          icon={Hourglass}
          tone="indigo"
        />
        <StatCard
          title="With the client"
          value={s.withClient}
          icon={Hourglass}
          tone="amber"
        />
        <StatCard
          title="Changes asked for"
          value={s.changes}
          icon={PencilLine}
          tone={s.changes > 0 ? "rose" : "sky"}
        />
      </div>

      {nothingAssigned ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nothing is assigned to you for {month}. When the super admin puts work on your
            name it appears here.
          </CardContent>
        </Card>
      ) : null}

      {/* What to pick up. Across every month, because last month's leftover is
          the first thing to do, not the thing this page hides. */}
      {work.upNext.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">Up next</CardTitle>
            <p className="text-xs text-muted-foreground">
              Soonest first, including anything left over from an earlier month.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <tr>
                  <th>Task</th>
                  <th>Client</th>
                  <th>Stage</th>
                  <th className="whitespace-nowrap">Due</th>
                  <th className="text-right">Open</th>
                </tr>
              </THead>
              <TBody>
                {work.upNext.map((t) => (
                  <TR key={t.id}>
                    <TD className="max-w-[18rem]">
                      <span className="truncate font-medium">{t.title}</span>
                    </TD>
                    <TD className="text-muted-foreground">{t.company}</TD>
                    <TD>
                      <Badge tone={editorStatusTone(t.status)}>{editorStatusLabel(t.status)}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap tabular-nums">
                      <span className={t.overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {t.dueDate ? fmtDate(t.dueDate) : "No date"}
                      </span>
                    </TD>
                    <TD className="text-right">
                      <Link
                        href={`/deliverables/${t.id}`}
                        className={buttonClasses({ variant: "ghost", size: "sm" })}
                      >
                        Open <ArrowRight className="h-4 w-4" />
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {/* The month by client — "how many did the super admin give me, and how
          many of each are done", which is the question asked most. */}
      {work.clients.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">Your clients this month</CardTitle>
            <p className="text-xs text-muted-foreground">
              {s.clients} client{s.clients === 1 ? "" : "s"}, {s.assigned} task
              {s.assigned === 1 ? "" : "s"} between them.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <tr>
                  <th>Client</th>
                  <th className="text-center">Assigned</th>
                  <th className="text-center">Finished</th>
                  <th className="text-center">Still to do</th>
                  <th className="whitespace-nowrap">Next due</th>
                  <th>Progress</th>
                </tr>
              </THead>
              <TBody>
                {work.clients.map((c) => {
                  const pct = c.assigned ? Math.round((c.done / c.assigned) * 100) : 0;
                  return (
                    <TR key={c.clientId}>
                      <TD className="font-medium">{c.company}</TD>
                      <TD className="text-center tabular-nums">{c.assigned}</TD>
                      <TD className="text-center tabular-nums text-emerald-600 dark:text-emerald-400">
                        {c.done}
                      </TD>
                      <TD className="text-center tabular-nums">
                        {c.toDo || <span className="text-muted-foreground">—</span>}
                      </TD>
                      <TD className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {c.nextDue ? fmtDate(c.nextDue) : "—"}
                      </TD>
                      <TD className="w-40">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                            role="img"
                            aria-label={`${pct}% finished`}
                          >
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                            {pct}%
                          </span>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {/* Handed on, and out of their hands. Worth showing precisely because
          they cannot do anything about it — otherwise "did that go out?" is a
          question they have to ask a person. */}
      {waiting.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hourglass className="h-4 w-4 text-muted-foreground" />
              Waiting for the super admin
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              You&apos;ve finished these. The super admin checks them, then sends them to the
              client&apos;s WhatsApp group — nothing here needs anything from you.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {waiting.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{w.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {w.company}
                      {w.since ? ` · since ${fmtDate(String(w.since).slice(0, 10))}` : ""}
                    </p>
                  </div>
                  <Badge tone="info">{contentStatusLabel("caption_ready")}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
