"use client";

import { useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarRange, Wand2, Check, TriangleAlert, Loader2, Plus, Minus } from "lucide-react";
import {
  generateMonthAction,
  shiftMonthAction,
  setTaskDateAction,
  adjustTasksAction,
  type PlanState,
} from "./plan-actions";
import type { MonthPlan, PlannedTask } from "@/lib/task-plan";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Select } from "@/components/ui/select";
import { Badge, statusTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { label } from "@/lib/utils";

/** "2026-08" → "Aug 2026", for a picker that reads like a month and not a key. */
function monthLabel(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

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

/** The months worth offering: half a year either side, plus any that already have work. */
function monthOptions(current: string, used: string[]): string[] {
  const out = new Set<string>(used);
  const now = new Date();
  for (let i = -6; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  out.add(current);
  return [...out].sort().reverse();
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
 * One task's due date, changed where it sits.
 *
 * Saves as soon as a date is picked rather than behind a button: the row is
 * already the thing being edited, and a save button per row is fifteen buttons
 * on a full month, fourteen of which are always wrong to press.
 */
function TaskDate({ clientId, task }: { clientId: number; task: PlannedTask }) {
  const [state, action, pending] = useActionState<PlanState, FormData>(setTaskDateAction, {});
  const form = useRef<HTMLFormElement>(null);

  return (
    <form ref={form} action={action} className="flex items-center gap-2">
      <input type="hidden" name="client_id" value={clientId} />
      <input type="hidden" name="task_id" value={task.id} />
      <DateField
        name="due_date"
        defaultValue={task.due_date ? String(task.due_date).slice(0, 10) : ""}
        onChange={() => form.current?.requestSubmit()}
        aria-label={`Posting date for ${task.title}`}
        className="w-[11rem]"
      />
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
      {!pending && state.ok ? <Check className="h-3.5 w-3.5 text-success" /> : null}
      {!pending && state.error ? (
        <span title={state.error}>
          <TriangleAlert className="h-3.5 w-3.5 text-destructive" />
        </span>
      ) : null}
    </form>
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
  usedMonths,
  canForce = false,
}: {
  clientId: number;
  plan: MonthPlan;
  tasks: PlannedTask[];
  usedMonths: string[];
  /** Super admin only — deleting work somebody has started. */
  canForce?: boolean;
}) {
  const router = useRouter();
  const [genState, generate, generating] = useActionState<PlanState, FormData>(
    generateMonthAction,
    {}
  );
  const [shiftState, shift, shifting] = useActionState<PlanState, FormData>(shiftMonthAction, {});
  const [adjState, adjust, adjusting] = useActionState<PlanState, FormData>(adjustTasksAction, {});

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
        <Select
          aria-label="Month"
          value={plan.month}
          onChange={(e) => router.push(`?plan=${e.target.value}`, { scroll: false })}
          className="h-8 w-36 text-xs"
        >
          {monthOptions(plan.month, usedMonths).map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </Select>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
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
          No tasks in {monthLabel(plan.month)}.
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
                  <TaskDate clientId={clientId} task={t} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
