import { Wallet, TrendingDown, AlarmClock, Repeat2, Scale } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { query, queryOne, hasTable } from "@/lib/db";
import { getExpenseBoard, categoryLabel } from "@/lib/expenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { money } from "@/lib/utils";
import { ExpenseTable, type Row } from "./expense-table";

export const metadata = { title: "Expenses · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * What the agency spends, next to what it took in.
 *
 * The portal has always known what comes in and nothing about what goes out,
 * which makes every revenue figure on it half an answer. The pairing is the
 * point: ₹4L billed is a good month or a bad one depending on a number that
 * used to live in somebody's head.
 *
 * Reachable by admins only. Most rows here — salaries, rent — belong to no
 * client, so the crm scoping that governs every other board has nothing to
 * scope by and no business seeing the total.
 */
export default async function ExpensesPage() {
  await requireUser(ADMIN_ROLES);

  // Feature-gated like every other addition: a database that has not run the
  // migration gets told how to, rather than a stack trace.
  if (!(await hasTable("expenses"))) {
    return (
      <div className="space-y-5">
        <Header />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <Wallet className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">One step to switch this on</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Expenses needs a table that isn&apos;t in this database yet. Open{" "}
              <span className="font-medium text-foreground">Settings → Database</span> and apply
              the pending changes — it takes a second and touches nothing existing.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const [board, clients, todayRow] = await Promise.all([
    getExpenseBoard(),
    query<{ id: number; company_name: string }>(
      "SELECT id, company_name FROM clients WHERE status != 'churned' ORDER BY company_name"
    ),
    // The database's today, not this server's. They disagree for five and a
    // half hours a day, and a due date is compared in SQL.
    queryOne<{ d: string; soon: string }>(
      "SELECT CURDATE() AS d, CURDATE() + INTERVAL 14 DAY AS soon"
    ),
  ]);

  const today = String(todayRow?.d ?? "").slice(0, 10);
  const soonCutoff = String(todayRow?.soon ?? "").slice(0, 10);

  const rows: Row[] = board.rows.map((r) => {
    const due = String(r.due_on).slice(0, 10);
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      amount: r.amount,
      vendor: r.vendor,
      dueOn: due,
      paidOn: r.paid_on ? String(r.paid_on).slice(0, 10) : null,
      repeats: r.repeats,
      remind: Number(r.remind) === 1,
      remindDays: r.remind_days,
      clientId: r.client_id,
      clientName: r.company_name,
      note: r.note,
      overdue: !r.paid_on && due < today,
      dueSoon: !r.paid_on && due >= today && due <= soonCutoff,
    };
  });

  const left = board.receivedThisMonth - board.spentThisMonth;
  const change = board.spentLastMonth
    ? Math.round(((board.spentThisMonth - board.spentLastMonth) / board.spentLastMonth) * 100)
    : null;

  const biggest = board.byCategory[0];
  const categoryTotal = board.byCategory.reduce((n, c) => n + c.total, 0);

  return (
    <div className="space-y-5">
      <Header />

      {/* The four numbers worth knowing before scrolling. Overdue leads when
          there is any, because it is the only one that costs money to ignore. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Spent this month"
          value={money(board.spentThisMonth)}
          icon={TrendingDown}
          tone="orange"
          hint={
            change === null
              ? "Nothing to compare with yet"
              : `${change >= 0 ? "+" : ""}${change}% on last month (${money(board.spentLastMonth)})`
          }
        />
        <StatCard
          title="Left this month"
          value={money(left)}
          icon={Scale}
          tone={left >= 0 ? "emerald" : "rose"}
          hint={`${money(board.receivedThisMonth)} received, ${money(board.spentThisMonth)} spent`}
        />
        <StatCard
          title={board.overdue.count > 0 ? "Overdue" : "Due in 14 days"}
          value={
            board.overdue.count > 0 ? money(board.overdue.total) : money(board.dueSoon.total)
          }
          icon={AlarmClock}
          tone={board.overdue.count > 0 ? "rose" : "amber"}
          hint={
            board.overdue.count > 0
              ? `${board.overdue.count} payment${board.overdue.count === 1 ? "" : "s"} past due · ${money(board.dueSoon.total)} more coming`
              : board.dueSoon.count > 0
                ? `${board.dueSoon.count} payment${board.dueSoon.count === 1 ? "" : "s"} · nothing overdue`
                : "Nothing owed right now"
          }
        />
        <StatCard
          title="Committed every month"
          value={money(board.committedMonthly)}
          icon={Repeat2}
          tone="sky"
          hint="Repeating costs, spread to a monthly figure"
        />
      </div>

      {board.byCategory.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Where it went this month</CardTitle>
            <p className="text-xs text-muted-foreground">
              {biggest
                ? `${categoryLabel(biggest.category)} is the largest, at ${Math.round(
                    (biggest.total / (categoryTotal || 1)) * 100
                  )}% of the month.`
                : null}
            </p>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {board.byCategory.map((c) => {
              const pct = Math.round((c.total / (categoryTotal || 1)) * 100);
              return (
                <div key={c.category} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate text-sm">{categoryLabel(c.category)}</span>
                  {/* A bar rather than a pie: eight categories compared against
                      each other read better in a row than in a circle. */}
                  <span
                    className="h-2 min-w-[2px] rounded-full bg-primary/70"
                    style={{ width: `${Math.max(2, pct)}%` }}
                    aria-hidden="true"
                  />
                  <span className="ml-auto shrink-0 text-sm tabular-nums text-muted-foreground">
                    {money(c.total)}
                  </span>
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {pct}%
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <ExpenseTable rows={rows} clients={clients} today={today} />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Wallet className="h-6 w-6 text-primary" />
        Expenses
      </h1>
      <p className="text-sm text-muted-foreground">
        What goes out, and what is about to. Repeating costs come back on their own date.
      </p>
    </div>
  );
}
