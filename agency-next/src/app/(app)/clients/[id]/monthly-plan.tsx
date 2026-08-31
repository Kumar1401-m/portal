"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  CalendarRange,
  Wand2,
  Check,
  TriangleAlert,
  Loader2,
  Plus,
  Minus,
  Pencil,
} from "lucide-react";
import {
  respaceMonthAction,
  generateMonthAction,
  shiftMonthAction,
  adjustTasksAction,
  saveMonthPlanAction,
  clearMonthPlanAction,
  type PlanState,
} from "./plan-actions";
import type { MonthPlan, PlannedTask } from "@/lib/task-plan";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TaskDate } from "../../deliverables/task-date";
import { Select } from "@/components/ui/select";
import { Badge, statusTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { MonthStepper } from "@/components/ui/month-stepper";
import { monthRangeLabel } from "@/lib/date-range";
import { label, money } from "@/lib/utils";

/**
 * The day generated tasks land on: the first of the month, or today if that
 * month is already underway — matching what the generator writes, so the
 * sentence on screen is not a different promise from the one kept.
 */
function startDayLabel(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  if (!y || !m) return mk;
  const first = new Date(y, m - 1, 1);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = first > today ? first : today.getMonth() === m - 1 && today.getFullYear() === y ? today : first;
  return day.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function Note({ state }: { state: PlanState }) {
  if (state.error) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-success">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * What this particular month owes, and what it costs.
 *
 * The contract on the client record holds one pair of numbers standing for
 * every month there will ever be. A client who wants twelve videos in
 * September instead of the usual eight, and two extra posters, could only be
 * recorded by editing it — which then reported twelve for August too, and for
 * every month already closed.
 *
 * So a month can be agreed on its own, and agreed *ahead*: step the month
 * forward and write next month's plan now. Everything else on this card then
 * reads those numbers instead of the contract's.
 *
 * Nothing is calculated. There is no rate table because what a month is worth
 * is settled in a conversation, and a month with two extra posters is not
 * reliably a month costing two posters more.
 */
function AgreeMonth({
  clientId,
  plan,
  contract,
}: {
  clientId: number;
  plan: MonthPlan;
  /** What the contract says, shown as the placeholder when nothing is agreed. */
  contract: { videos: number; posters: number; amount: number };
}) {
  const [state, save, saving] = useActionState<PlanState, FormData>(saveMonthPlanAction, {});
  const [clearState, clear, clearing] = useActionState<PlanState, FormData>(
    clearMonthPlanAction,
    {}
  );
  const [open, setOpen] = useState(false);
  const agreed = plan.agreed;

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">This month</p>
          <p className="text-sm">
            {agreed ? (
              <>
                <b className="tabular-nums">{money(agreed.amount)}</b> agreed for{" "}
                {plan.videoTarget} video{plan.videoTarget === 1 ? "" : "s"} and{" "}
                {plan.posterTarget} poster{plan.posterTarget === 1 ? "" : "s"}
                {agreed.invoiceNo ? (
                  <span className="text-muted-foreground"> · invoice {agreed.invoiceNo}</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                Following the contract — {contract.videos} video
                {contract.videos === 1 ? "" : "s"}, {contract.posters} poster
                {contract.posters === 1 ? "" : "s"}
                {contract.amount ? `, ${money(contract.amount)}` : ""}.
              </span>
            )}
          </p>
          {agreed?.note ? <p className="mt-1 text-xs text-muted-foreground">{agreed.note}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={buttonClasses({ variant: "ghost", size: "sm" })}
        >
          <Pencil className="h-3.5 w-3.5" />
          {agreed ? "Change" : "Agree this month"}
        </button>
      </div>

      {open ? (
        <>
          <form action={save} className="mt-3 space-y-2">
            <input type="hidden" name="client_id" value={clientId} />
            <input type="hidden" name="month" value={plan.month} />
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Videos</span>
                <Input
                  name="videos"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={agreed ? plan.videoTarget : contract.videos}
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Posters</span>
                <Input
                  name="posters"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={agreed ? plan.posterTarget : contract.posters}
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Amount for this month (₹)</span>
                <Input
                  name="amount"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={agreed ? agreed.amount : contract.amount || ""}
                />
              </label>
            </div>
            <Input name="note" placeholder="What was agreed (optional)" defaultValue={agreed?.note ?? ""} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={saving} className={buttonClasses({ size: "sm" })}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Save this month
              </button>
              {/*
                Said plainly, because it is the part that reaches the client.
                Saving raises the invoice and sends it; saving again never
                sends a second one — the month is claimed by the first.
              */}
              <span className="text-xs text-muted-foreground">
                {agreed?.invoiceNo
                  ? `Invoice ${agreed.invoiceNo} already sent for this month — saving again won't send another.`
                  : "The invoice goes to the client when you save."}
              </span>
            </div>
          </form>
          <Note state={state} />

          {agreed ? (
            <form action={clear} className="mt-2">
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="month" value={plan.month} />
              <button
                type="submit"
                disabled={clearing}
                className={buttonClasses({ variant: "ghost", size: "sm" })}
              >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Back to the contract
              </button>
              <span className="ml-2 text-xs text-muted-foreground">
                Any invoice already raised stays — cancel it on the Payments page.
              </span>
            </form>
          ) : null}
          <Note state={clearState} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The month, as a plan rather than a list.
 *
 * A client's contract already says how many videos and posters a month owes.
 * This is where that number becomes the tasks, and where the dates they all
 * start on get spread out — one at a time on the rows, or the whole month at
 * once when it slips.
 */
export function MonthlyPlan({
  clientId,
  plan,
  tasks,
  canForce = false,
  contract,
}: {
  clientId: number;
  plan: MonthPlan;
  tasks: PlannedTask[];
  /** Super admin only — deleting work somebody has started. */
  canForce?: boolean;
  /** What the client record says, for the months that follow it. */
  contract: { videos: number; posters: number; amount: number };
}) {
  const [genState, generate, generating] = useActionState<PlanState, FormData>(
    generateMonthAction,
    {}
  );
  const [shiftState, shift, shifting] = useActionState<PlanState, FormData>(shiftMonthAction, {});
  const [adjState, adjust, adjusting] = useActionState<PlanState, FormData>(adjustTasksAction, {});
  const [spaceState, respace, respacing] = useActionState<PlanState, FormData>(
    respaceMonthAction,
    {}
  );

  const toAdd = plan.videosToAdd + plan.postersToAdd;
  const noTargets = plan.videoTarget === 0 && plan.posterTarget === 0;

  /*
   * More on the board than the contract asks for.
   *
   * "Nothing missing" is true and useless when a month holds twenty against a
   * target of ten: nothing is missing, ten are spare, and the badge said the
   * plan was in order. A month can be wrong in both directions.
   */
  const overVideos = Math.max(0, plan.videosExisting - plan.videoTarget);
  const overPosters = Math.max(0, plan.postersExisting - plan.posterTarget);
  const over = overVideos + overPosters;
  const overSummary = [
    overVideos ? `${overVideos} video${overVideos > 1 ? "s" : ""}` : "",
    overPosters ? `${overPosters} poster${overPosters > 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" and ");

  const summary = [
    plan.videosToAdd ? `${plan.videosToAdd} video${plan.videosToAdd > 1 ? "s" : ""}` : "",
    plan.postersToAdd ? `${plan.postersToAdd} poster${plan.postersToAdd > 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarRange className="h-4 w-4 text-muted-foreground" /> Monthly plan
        </CardTitle>
        {/* Stepped, not picked — and the same stepper the ads board uses, so
            the year rolls over correctly in one place rather than two. */}
        <MonthStepper month={plan.month} href={(m) => `?plan=${m}`} />
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {/*
          Above the targets, not inside them: a client with nothing on their
          contract can still be agreed a month, and that is exactly the client
          the branch below tells to go and edit their contract.
        */}
        <AgreeMonth clientId={clientId} plan={plan} contract={contract} />

        {noTargets ? (
          <p className="text-xs text-muted-foreground">
            This client has no monthly video or poster count set, so there is nothing to plan
            from.{" "}
            <Link href={`/clients/${clientId}/edit`} className="text-primary hover:underline">
              Set it on the edit page
            </Link>
            .
          </p>
        ) : (
          <>
            {/* Only what the client actually buys. "Posters 0 of 0" on a
                video-only client is a row that says nothing and still has to
                be read past every time. */}
            <div className="grid gap-3 sm:grid-cols-2">
              {plan.videoTarget > 0 ? (
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Videos</p>
                  <p className="text-lg font-semibold tabular-nums">
                    {plan.videosExisting}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      of {plan.videoTarget}
                    </span>
                  </p>
                </div>
              ) : null}
              {plan.posterTarget > 0 ? (
                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Posters</p>
                  <p className="text-lg font-semibold tabular-nums">
                    {plan.postersExisting}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      of {plan.posterTarget}
                    </span>
                  </p>
                </div>
              ) : null}
            </div>

            {over > 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>
                  <b>{overSummary} more than the contract.</b> Remove the extras below —
                  untouched ones go straight away, and anything already started has to be
                  confirmed.
                </span>
              </p>
            ) : null}

            <form action={generate} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="month" value={plan.month} />
              <button
                type="submit"
                disabled={generating || toAdd === 0}
                className={buttonClasses({ size: "sm" })}
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                {toAdd === 0 ? (over ? "Nothing missing" : "Matches the contract") : `Add the missing ${summary}`}
              </button>
              {toAdd > 0 ? (
                <span className="text-xs text-muted-foreground">
                  All due {startDayLabel(plan.month)} — move them below.
                </span>
              ) : null}
            </form>
            <Note state={genState} />
          </>
        )}


            {/* Exactly how many, either direction. Generate answers "match the
                contract"; this answers "give me three more", which is a
                different question and deliberately not idempotent. */}
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium">Add or remove a set number</p>
              <form action={adjust} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="client_id" value={clientId} />
                <input type="hidden" name="month" value={plan.month} />
                <Input name="count" type="number" min="1" max="50" defaultValue="1" className="h-9 w-20" aria-label="How many" />
                <Select name="kind" defaultValue="video" className="h-9 w-28 text-sm" aria-label="Videos or posters">
                  <option value="video">videos</option>
                  <option value="poster">posters</option>
                </Select>
                <button type="submit" name="direction" value="add" disabled={adjusting}
                  className={buttonClasses({ variant: "outline", size: "sm" })}>
                  {adjusting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
                </button>
                <button type="submit" name="direction" value="remove" disabled={adjusting}
                  className={buttonClasses({ variant: "ghost", size: "sm" })}>
                  <Minus className="h-4 w-4" /> Remove
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                Removing only takes tasks nobody has started — no footage, no video, not sent to the client.
              </p>
              <Note state={adjState} />

              {/* Offered only after the safe attempt has actually been refused,
                  so deleting started work can never be the first thing tried.
                  Posted videos are never included, whatever is ticked: that row
                  holds the permalink and the date it went live. */}
              {adjState.blockedOnly && canForce ? (
                <form action={adjust} className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <input type="hidden" name="client_id" value={clientId} />
                  <input type="hidden" name="month" value={plan.month} />
                  <input type="hidden" name="include_started" value="1" />
                  <p className="text-xs">
                    <b>Delete them anyway?</b> This removes tasks with captions, footage or edits
                    on them, and ones the client has already been sent. Anything posted to
                    Instagram is kept.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      name="count"
                      type="number"
                      min="1"
                      max="50"
                      defaultValue={String(Math.min(50, over || 1))}
                      className="h-8 w-20"
                      aria-label="How many to delete"
                    />
                    <Select name="kind" defaultValue="video" className="h-8 w-28 text-sm" aria-label="Videos or posters">
                      <option value="video">videos</option>
                      <option value="poster">posters</option>
                    </Select>
                    <button
                      type="submit"
                      name="direction"
                      value="remove"
                      disabled={adjusting}
                      className={buttonClasses({ variant: "destructive", size: "sm" })}
                    >
                      {adjusting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Minus className="h-4 w-4" />}
                      Delete the started ones too
                    </button>
                  </div>
                </form>
              ) : null}
            </div>

        {tasks.length > 0 ? (
          <div className="space-y-2 border-t border-border pt-4">
            <form action={respace}>
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="month" value={plan.month} />
              <button
                type="submit"
                disabled={respacing}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                {respacing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarRange className="h-4 w-4" />}
                Space them two days apart
              </button>
            </form>
            <p className="text-xs text-muted-foreground">
              Re-dates this month from the start, two days between each — for months filled
              before that was the default. Posting times move with the dates; posted work is
              left alone.
            </p>
            <Note state={spaceState} />
          </div>
        ) : null}

        {tasks.length > 0 ? (
          <form action={shift} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <input type="hidden" name="client_id" value={clientId} />
            <input type="hidden" name="month" value={plan.month} />
            <div className="space-y-1">
              <label htmlFor="days" className="text-xs text-muted-foreground">
                Move every unfinished task by
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="days"
                  name="days"
                  type="number"
                  defaultValue="7"
                  className="h-9 w-24"
                  aria-label="Days to move by"
                />
                <span className="text-xs text-muted-foreground">days</span>
                <button
                  type="submit"
                  disabled={shifting}
                  className={buttonClasses({ variant: "outline", size: "sm" })}
                >
                  {shifting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Move
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Negative moves them earlier. Posted and approved work stays where it is.
            </p>
          </form>
        ) : null}
        <Note state={shiftState} />
      </CardContent>

      {tasks.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No tasks in {monthRangeLabel(plan.month)}.
        </p>
      ) : (
        <Table>
          <THead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              {/* The same date the Tasks board calls "Schedule date", and the
                  same value — they read one column now, not two. */}
              <th className="whitespace-nowrap">Schedule date</th>
            </tr>
          </THead>
          <TBody>
            {tasks.map((t) => (
              <TR key={t.id}>
                <TD>
                  <Link
                    href={`/deliverables/${t.id}`}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    {t.title}
                  </Link>
                  {t.content_category ? (
                    <span className="ml-2 text-xs text-muted-foreground">{t.content_category}</span>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone={statusTone(t.status)}>{label(t.status)}</Badge>
                </TD>
                <TD>
                  <TaskDate taskId={t.id} title={t.title} dueDate={t.due_date} compact={false} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
