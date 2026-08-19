"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Pencil, Plus, Repeat2, Trash2, BellOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { money, fmtDate } from "@/lib/utils";
import { EXPENSE_CATEGORIES, categoryLabel, REPEATS } from "@/lib/expense-kinds";
import {
  addExpenseAction,
  updateExpenseAction,
  deleteExpenseAction,
  markExpensePaidAction,
  type ExpenseState,
} from "./actions";

export type Row = {
  id: number;
  title: string;
  category: string;
  amount: number;
  vendor: string | null;
  dueOn: string;
  paidOn: string | null;
  repeats: string;
  remind: boolean;
  remindDays: number;
  clientId: number | null;
  clientName: string | null;
  note: string | null;
  /** Worked out on the server, against the database's idea of today. */
  overdue: boolean;
  dueSoon: boolean;
};

/**
 * The ledger, and the one form that writes to it.
 *
 * Unpaid rows sit at the top with the oldest first, because this board is a
 * worklist before it is a record — what is owed is the question, and what was
 * paid three weeks ago is the answer to a different one.
 */
export function ExpenseTable({
  rows,
  clients,
  today,
}: {
  rows: Row[];
  clients: { id: number; company_name: string }[];
  /** The database's today, so a new expense defaults to a date it agrees with. */
  today: string;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-medium">Everything recorded</h2>
          <p className="text-xs text-muted-foreground">
            What is owed first, oldest due date at the top.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add an expense
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="p-10 text-center text-sm text-muted-foreground">
          Nothing recorded yet. Add the ones that repeat first — salaries, subscriptions, rent —
          and the board starts warning you before they fall due.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table dense>
            <THead>
              <tr>
                {/* The category and the date fold under "What". */}
                <th>What</th>
                <th className="hidden md:table-cell">Category</th>
                <th className="text-right">Amount</th>
                <th className="hidden whitespace-nowrap sm:table-cell">Due</th>
                <th className="hidden sm:table-cell">Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <ExpenseRow key={r.id} row={r} clients={clients} today={today} />
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <ExpenseDialog
        open={adding}
        onClose={() => setAdding(false)}
        clients={clients}
        today={today}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function ExpenseRow({
  row,
  clients,
  today,
}: {
  row: Row;
  clients: { id: number; company_name: string }[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [gone, setGone] = useState(false);
  const toast = useToast();

  const run = (
    action: (p: ExpenseState, fd: FormData) => Promise<ExpenseState>,
    confirmText?: string
  ) => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      const fd = new FormData();
      fd.set("id", String(row.id));
      const res = await action({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Done." });
        if (action === deleteExpenseAction) setGone(true);
      } else {
        toast({ title: res.error ?? "Could not do that.", tone: "error" });
      }
    });
  };

  // Removed from the page the moment the server confirms it, so the row does
  // not sit there looking deleted-but-present until a revalidate lands.
  if (gone) return null;

  return (
    <>
      <TR>
        <TD className="max-w-[16rem]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="truncate text-left font-medium transition-colors hover:text-primary hover:underline"
            >
              {row.title}
            </button>
            {row.repeats !== "once" ? (
              <Repeat2
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-label={row.repeats}
              />
            ) : null}
            {!row.remind && !row.paidOn ? (
              <BellOff
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-label="No reminder"
              />
            ) : null}
          </div>
          {row.vendor || row.clientName ? (
            <p className="truncate text-xs text-muted-foreground">
              {[row.vendor, row.clientName].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {/* The category and the date, folded away on a phone. */}
          <p className="truncate text-xs text-muted-foreground sm:hidden">
            {categoryLabel(row.category)} · due {fmtDate(row.dueOn)}
          </p>
        </TD>
        <TD className="hidden text-muted-foreground md:table-cell">
          {categoryLabel(row.category)}
        </TD>
        <TD className="whitespace-nowrap text-right font-medium tabular-nums">
          {money(row.amount)}
        </TD>
        <TD className="hidden whitespace-nowrap tabular-nums sm:table-cell">
          <span
            className={
              row.overdue && !row.paidOn ? "font-medium text-destructive" : "text-muted-foreground"
            }
          >
            {fmtDate(row.dueOn)}
          </span>
        </TD>
        <TD className="hidden sm:table-cell">
          {row.paidOn ? (
            <Badge tone="success">Paid {fmtDate(row.paidOn)}</Badge>
          ) : row.overdue ? (
            <Badge tone="danger">Overdue</Badge>
          ) : row.dueSoon ? (
            <Badge tone="warning">Due soon</Badge>
          ) : (
            <Badge tone="muted">Upcoming</Badge>
          )}
        </TD>
        <TD>
          <div className="flex items-center justify-end gap-1">
            {row.paidOn ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => run(markExpensePaidAction)}
                disabled={pending}
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Paid
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              disabled={pending}
              aria-label={`Edit ${row.title}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                run(
                  deleteExpenseAction,
                  `Delete "${row.title}"? ${
                    row.repeats === "once" ? "" : "Only this one — the others in the series stay."
                  }`
                )
              }
              aria-label={`Delete ${row.title}`}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </TD>
      </TR>

      {/* Mounted per row rather than one shared dialog holding an id: the
          Modal renders nothing when closed, so the fields remount from this
          row's values every time it opens and cannot show the last one's. */}
      <ExpenseDialog
        open={editing}
        onClose={() => setEditing(false)}
        clients={clients}
        today={today}
        row={row}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One dialog for both jobs.
 *
 * Adding and correcting are the same eleven fields, and a second component
 * for the second job is two places for a field to be added and one place for
 * it to be forgotten. `row` decides which action the submit goes to and what
 * the fields start as; everything else is identical, because it should be.
 */
function ExpenseDialog({
  open,
  onClose,
  clients,
  today,
  row,
}: {
  open: boolean;
  onClose: () => void;
  clients: { id: number; company_name: string }[];
  today: string;
  /** Absent when adding. Present when correcting one already recorded. */
  row?: Row;
}) {
  const [pending, start] = useTransition();
  const [repeats, setRepeats] = useState(row?.repeats ?? "once");
  const toast = useToast();

  const editing = Boolean(row);
  // Unique per row, so two dialogs' worth of markup can never share an id — a
  // label pointing at another row's field is the sort of thing nobody notices.
  const uid = row ? `e${row.id}` : "new";

  const submit = (fd: FormData) => {
    start(async () => {
      const res = editing
        ? await updateExpenseAction({ ok: false }, fd)
        : await addExpenseAction({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Saved." });
        onClose();
      } else {
        toast({ title: res.error ?? "Could not save it.", tone: "error" });
      }
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={row ? row.title : "Add an expense"}>
      {/*
        The form has to be the flex column, not a plain wrapper inside it.

        `Modal` is a flex column capped at 90vh, and it applies to its own
        children. A <form> dropped in between meant the body's `flex-1
        overflow-y-auto` and the footer's `shrink-0` were being applied to
        children of the form instead — so the body never scrolled, the whole
        thing grew past the viewport, and Save went off the bottom of the
        screen. `min-h-0` is the other half: a flex child will not shrink below
        its content without it, whatever the overflow says.
      */}
      <form action={submit} className="flex min-h-0 flex-1 flex-col">
        {row ? <input type="hidden" name="id" value={row.id} /> : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-title`}>What is it for</Label>
              <Input
                id={`${uid}-title`}
                name="title"
                required
                defaultValue={row?.title ?? ""}
                placeholder="Adobe Creative Cloud"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-amount`}>Amount</Label>
              <Input
                id={`${uid}-amount`}
                name="amount"
                required
                inputMode="decimal"
                defaultValue={row ? String(row.amount) : ""}
                placeholder="4,230"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-due`}>Due on</Label>
              <Input
                id={`${uid}-due`}
                name="due_on"
                type="date"
                required
                defaultValue={row?.dueOn ?? today}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-category`}>Category</Label>
              <Select
                id={`${uid}-category`}
                name="category"
                defaultValue={row?.category ?? "software"}
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-repeats`}>Repeats</Label>
              <Select
                id={`${uid}-repeats`}
                name="repeats"
                value={repeats}
                onChange={(e) => setRepeats(e.target.value)}
              >
                {REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {r === "once" ? "One-off" : r[0].toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-vendor`}>
                Paid to <span className="font-normal text-muted-foreground">— optional</span>
              </Label>
              <Input
                id={`${uid}-vendor`}
                name="vendor"
                defaultValue={row?.vendor ?? ""}
                placeholder="Adobe"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-client`}>
                Against a client{" "}
                <span className="font-normal text-muted-foreground">— optional</span>
              </Label>
              <Select
                id={`${uid}-client`}
                name="client_id"
                defaultValue={row?.clientId ? String(row.clientId) : ""}
              >
                <option value="">Not client-specific</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company_name}
                  </option>
                ))}
              </Select>
            </div>

            {/* Only where there is a payment to re-date, and it lands on a row
                of its own — so the empty half beside it says why un-paying is
                not offered rather than just sitting there looking unfinished. */}
            {row?.paidOn ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-paid`}>Paid on</Label>
                  <Input id={`${uid}-paid`} name="paid_on" type="date" defaultValue={row.paidOn} />
                </div>
                <p className="self-end pb-2.5 text-xs text-muted-foreground">
                  Correcting the day it actually went out. To undo the payment itself, delete this
                  one and add it again.
                </p>
              </>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-note`}>
              Note <span className="font-normal text-muted-foreground">— optional</span>
            </Label>
            <Textarea
              id={`${uid}-note`}
              name="note"
              rows={2}
              defaultValue={row?.note ?? ""}
              placeholder="Annual plan, 5 seats."
            />
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            {/* Adding only. On a row that exists, paying is the button on the
                row itself — paying a repeating expense also creates the next
                one, and a checkbox cannot say that. */}
            {editing ? null : (
              <label
                htmlFor={`${uid}-paidnow`}
                className="flex cursor-pointer items-center gap-2.5 text-sm"
              >
                <input
                  id={`${uid}-paidnow`}
                  type="checkbox"
                  name="paid_now"
                  value="1"
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                <span>
                  Already paid
                  {repeats !== "once" ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — the next one is created straight away
                    </span>
                  ) : null}
                </span>
              </label>
            )}

            {/* The notice period sits on the same line as the switch it
                belongs to. Stacked underneath it read as a third setting. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
              <label
                htmlFor={`${uid}-remind`}
                className="flex cursor-pointer items-center gap-2.5"
              >
                <input
                  id={`${uid}-remind`}
                  type="checkbox"
                  name="remind"
                  value="1"
                  defaultChecked={row ? row.remind : true}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                <span>Remind me</span>
              </label>
              <Input
                id={`${uid}-days`}
                name="remind_days"
                type="number"
                min={0}
                max={60}
                defaultValue={row?.remindDays ?? 3}
                className="h-8 w-16"
                aria-label="Days of notice before it is due"
              />
              <Label htmlFor={`${uid}-days`} className="font-normal">
                days before it is due
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Shows on this board and in the daily reminder.
            </p>
          </div>

          {/* A repeating expense is a chain of rows, so a change here is a
              change from here. The instances already recorded are what was
              owed at the time, and rewriting them to match a new price would
              make every past month wrong. */}
          {row && row.repeats !== "once" ? (
            <p className="text-xs text-muted-foreground">
              Changes apply to this one only. The instances already recorded keep what they were,
              and the next one is created from this row when it is marked paid.
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : editing ? (
              <Check className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editing ? "Save changes" : "Add expense"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
