import Link from "next/link";
import { ArrowLeft, BellRing, Database, WifiOff } from "lucide-react";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { query } from "@/lib/db";
import { getServiceStatus } from "@/lib/whatsapp-service-client";
import { SENDABLE } from "@/lib/reminder-messages";
import {
  listScheduled,
  listHistory,
  outboxReady,
  REMINDER_TIMEZONE,
  type OutboxRow,
} from "@/lib/reminder-outbox";
import {
  pendingReminders,
  recentlySent,
  sentByClient,
  unreachableClients,
} from "@/lib/whatsapp-reminders";
import { lastRuns, type JobRun } from "@/lib/automation-runs";
import { utcToLocalInput } from "@/lib/posting";
import { Card, CardContent } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { SendPanel } from "./send-panel";
import { ScheduleList, type ScheduledItem } from "./schedule-list";
import { AutomaticPanel, type AutomaticStatus } from "./automatic-panel";

export const metadata = { title: "Reminders · NVK Hub" };
export const dynamic = "force-dynamic";

// Keyed loosely: the stored kind is whatever was written when the row was
// queued, and an old row from a reminder that has since been renamed should
// still show something readable rather than crash the page.
const KIND_LABEL = new Map<string, string>(SENDABLE.map((s) => [s.kind, s.label]));

/** "09 Aug, 6:00 pm" — a stored UTC time in the clock the admin typed it in. */
function whenLabel(utc: string | null): string {
  const local = utcToLocalInput(utc, REMINDER_TIMEZONE); // "2026-08-09T18:00"
  if (!local) return "—";
  const [date, time] = local.split("T");
  const d = new Date(`${date}T00:00:00`);
  const [h, m] = time.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return (
    `${d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}, ` +
    `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`
  );
}

/** "3 hours ago". Vague on purpose — the exact minute is never the question. */
function ago(utc: string): string {
  const ms = Date.now() - Date.parse(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return "at an unknown time";
  const mins = Math.round(ms / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * A heartbeat, plus whether it is late.
 *
 * "Late" is generous — roughly double the interval — because the answer that
 * matters is "has this stopped", not "did it drift by a minute". A daily job
 * seen 26 hours ago is fine; one seen three days ago is not.
 */
function beat(run: JobRun | undefined, staleAfterMinutes: number) {
  if (!run) return null;
  const ms = Date.now() - Date.parse(`${run.ran_at.replace(" ", "T")}Z`);
  return {
    agoLabel: ago(run.ran_at),
    ok: Number(run.ok) === 1,
    summary: run.summary,
    stale: !Number.isNaN(ms) && ms > staleAfterMinutes * 60_000,
  };
}

const PENDING_LABELS: { key: keyof Awaited<ReturnType<typeof pendingReminders>>; label: string; when: string }[] = [
  { key: "approval_chase", label: "approval chases", when: "12h after the video was sent" },
  { key: "auto_approve", label: "approve themselves", when: "24h of silence" },
  { key: "footage_due", label: "footage requests", when: "3 days before the shoot" },
  { key: "monthly_plan", label: "month plans", when: "once this month" },
  { key: "invoice_due", label: "payment reminders", when: "weekly while unpaid" },
];

const SENT_LABELS: Record<string, string> = {
  approval_chase: "approval chases",
  auto_approve: "auto-approved",
  footage_due: "footage requests",
  monthly_plan: "month plans",
  invoice_due: "payment reminders",
  team_digest: "team digests",
};

function toItem(r: OutboxRow): ScheduledItem {
  return {
    id: r.id,
    kind: r.kind,
    kindLabel: KIND_LABEL.get(r.kind) || r.kind.replace(/_/g, " "),
    // The group name is stored on the row rather than joined, so a message
    // still says where it went after the group is unlinked.
    who: r.company_name || r.group_label || "Unknown group",
    body: r.body,
    whenLabel: whenLabel(r.status === "sent" ? r.sent_at || r.send_at : r.send_at),
    status: r.status,
    attempts: Number(r.attempts) || 0,
    lastError: r.last_error,
    byWhom: r.created_by_name,
  };
}

/**
 * Sending the reminders by hand.
 *
 * The nightly rules cover the routine: chase an approval after twelve hours,
 * ask for footage three days out, invoice weekly. This page is for everything
 * they can't know about — a client who promised footage on the phone, a
 * payment that needs asking for today rather than on Monday, a message that
 * should land at six rather than whenever the job happens to run.
 *
 * Super admin only. Every one of these lands in a real client's WhatsApp
 * group, which is the agency's most direct line to the people paying it.
 */
export default async function RemindersPage() {
  await requireUser(SUPER_ADMIN_ROLES);

  const ready = await outboxReady();
  if (!ready) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Reminders</h1>
        <Card>
          <CardContent className="flex items-start gap-3 p-6">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-2">
              <p className="font-medium">The reminder queue isn&apos;t set up yet.</p>
              <p className="text-sm text-muted-foreground">
                It needs one new table. Apply the pending changes from Settings, or run{" "}
                <code className="rounded bg-muted px-1">node database/migrate.js</code>.
              </p>
              <Link href="/settings" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                Open Settings
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /*
   * Every active client, and whether we can actually reach them.
   *
   * A client with no linked group is listed but not selectable. Hiding them
   * would raise the wrong question — "why isn't Ortho in this list?" is harder
   * to answer than "Ortho — no WhatsApp group", which says what to fix.
   */
  const [clients, scheduled, history, status, pending, runs, week, unreachable, byClient] =
    await Promise.all([
      query<{ id: number; company_name: string; group_count: number }>(
        `SELECT c.id, c.company_name,
                (SELECT COUNT(*) FROM whatsapp_groups g
                  WHERE g.client_id = c.id AND g.is_active = 1) AS group_count
           FROM clients c
          WHERE c.status <> 'churned'
          ORDER BY c.company_name`
      ),
      listScheduled(),
      listHistory(),
      getServiceStatus(),
      pendingReminders(),
      lastRuns(),
      recentlySent(7),
      unreachableClients(),
      // Who actually got messaged, which is the question the counts above
      // cannot answer and the one somebody comes here with.
      sentByClient(7),
    ]);

  const connected = status.ok && status.connected;

  const automatic: AutomaticStatus = {
    pending: PENDING_LABELS.map((p) => ({ label: p.label, when: p.when, n: pending[p.key] })),
    totalPending: pending.total,
    // A daily job is late after ~26 hours; a five-minute poll after ~20 minutes.
    daily: beat(runs.whatsapp_reminders, 26 * 60),
    poll: beat(runs.whatsapp_outbox, 20),
    sentThisWeek: week.map((w) => ({
      kind: w.kind,
      label: SENT_LABELS[w.kind] || w.kind.replace(/_/g, " "),
      n: Number(w.n) || 0,
    })),
    weekTotal: week.reduce((sum, w) => sum + (Number(w.n) || 0), 0),
    unreachable,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/settings" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BellRing className="h-6 w-6 text-primary" />
            Reminders
          </h1>
          <p className="text-sm text-muted-foreground">
            Send one now, or set it for a time and let it go out on its own.
          </p>
        </div>
      </div>

      {/* Said before anything is written, not after it fails to send. */}
      {!connected ? (
        <Card className="border-warning/40">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">WhatsApp isn&apos;t connected.</p>
              <p className="text-muted-foreground">
                Anything you schedule is kept and sent once it reconnects, but nothing will go
                out until then.{" "}
                <Link href="/settings/whatsapp" className="text-primary hover:underline">
                  Check the connection
                </Link>
                .
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <SendPanel
        kinds={SENDABLE.map((s) => ({ ...s }))}
        clients={clients.map((c) => ({
          id: c.id,
          company_name: c.company_name,
          hasGroup: Number(c.group_count) > 0,
        }))}
        teamGroupSet={Boolean(process.env.WHATSAPP_TEAM_GROUP_ID)}
      />

      <ScheduleList scheduled={scheduled.map(toItem)} history={history.map(toItem)} />

      <AutomaticPanel status={automatic} />

      {/*
        Who heard from us, and how much.
        
        The panel above counts messages by kind, which answers "is the machine
        running". This answers "did we pester that client", which is what
        somebody asks after a client says we did — and it is the only place
        that claim can be checked rather than argued about.
      */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3">
            <p className="text-sm font-medium">Who we messaged — last 7 days</p>
            <p className="text-xs text-muted-foreground">
              Newest first. <b>Today</b> is what the daily ceiling of four counts against; past
              it, everything for that client waits until tomorrow.
            </p>
          </div>
          {byClient.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nothing automatic has gone out in the last week.
            </p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-border bg-muted/60 backdrop-blur">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Client</th>
                    <th className="px-3 py-2 text-left font-medium">About</th>
                    <th className="px-3 py-2 text-right font-medium">Today</th>
                    <th className="px-3 py-2 text-right font-medium">Week</th>
                    <th className="px-3 py-2 text-left font-medium">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {byClient.map((r) => (
                    <tr
                      key={`${r.clientId}-${r.kind}`}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-1.5">
                        {r.clientId ? (
                          <Link
                            href={`/clients/${r.clientId}`}
                            className="transition-colors hover:text-primary hover:underline"
                          >
                            {r.company}
                          </Link>
                        ) : (
                          r.company
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {SENT_LABELS[r.kind] || r.kind.replace(/_/g, " ")}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {Number(r.today) || 0}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {Number(r.total) || 0}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {String(r.last).slice(5, 16).replace("T", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
