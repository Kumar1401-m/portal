"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Plus, Repeat2, Trash2, BellOff } from "lucide-react";
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
  const [open, setOpen] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-medium">Everything recorded</h2>
          <p className="text-xs text-muted-foreground">
            What is owed first, oldest due date at the top.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
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
                <th>What</th>
                <th>Category</th>
                <th className="text-right">Amount</th>
                <th className="whitespace-nowrap">Due</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <ExpenseRow key={r.id} row={r} />
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <AddExpense open={open} onClose={() => setOpen(false)} clients={clients} today={today} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function ExpenseRow({ row }: { row: Row }) {
  const [pending, start] = useTransition();
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
    <TR>
      <TD className="max-w-[16rem]">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{row.title}</span>
          {row.repeats !== "once" ? (
            <Repeat2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={row.repeats} />
          ) : null}
          {!row.remind && !row.paidOn ? (
            <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="No reminder" />
          ) : null}
        </div>
        {row.vendor || row.clientName ? (
          <p className="truncate text-xs text-muted-foreground">
            {[row.vendor, row.clientName].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </TD>
      <TD className="text-muted-foreground">{categoryLabel(row.category)}</TD>
      <TD className="whitespace-nowrap text-right font-medium tabular-nums">{money(row.amount)}</TD>
      <TD className="whitespace-nowrap tabular-nums">
        <span className={row.overdue && !row.paidOn ? "font-medium text-destructive" : "text-muted-foreground"}>
          {fmtDate(row.dueOn)}
        </span>
      </TD>
      <TD>
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
            <Button size="sm" variant="ghost" onClick={() => run(markExpensePaidAction)} disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Paid
            </Button>
          )}
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
  );
}

/* ------------------------------------------------------------------ */

function AddExpense({
  open,
  onClose,
  clients,
  today,
}: {
  open: boolean;
  onClose: () => void;
  clients: { id: number; company_name: string }[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [repeats, setRepeats] = useState("once");
  const toast = useToast();

  const submit = (fd: FormData) => {
    start(async () => {
      const res = await addExpenseAction({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Added." });
        onClose();
      } else {
        toast({ title: res.error ?? "Could not add it.", tone: "error" });
      }
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Add an expense">
      <form action={submit}>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="exp-title">What is it for</Label>
              <Input id="exp-title" name="title" required placeholder="Adobe Creative Cloud" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="exp-amount">Amount</Label>
              <Input id="exp-amount" name="amount" required inputMode="decimal" placeholder="4,230" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="exp-due">Due on</Label>
              <Input id="exp-due" name="due_on" type="date" required defaultValue={today} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="exp-category">Category</Label>
              <Select id="exp-category" name="category" defaultValue="software">
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="exp-repeats">Repeats</Label>
              <Select
                id="exp-repeats"
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

            <div className="space-y-2">
              <Label htmlFor="exp-vendor">
                Paid to <span className="font-normal text-muted-foreground">— optional</span>
              </Label>
              <Input id="exp-vendor" name="vendor" placeholder="Adobe" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="exp-client">
                Against a client <span className="font-normal text-muted-foreground">— optional</span>
              </Label>
              <Select id="exp-client" name="client_id" defaultValue="">
                <option value="">Not client-specific</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company_name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exp-note">
              Note <span className="font-normal text-muted-foreground">— optional</span>
            </Label>
            <Textarea id="exp-note" name="note" rows={2} placeholder="Annual plan, 5 seats." />
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <label htmlFor="exp-paid" className="flex cursor-pointer items-center gap-2.5 text-sm">
              <input
                id="exp-paid"
                type="checkbox"
                name="paid_now"
                value="1"
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span>
                Already paid
                {repeats !== "once" ? (
                  <span className="text-muted-foreground"> — the next one is created straight away</span>
                ) : null}
              </span>
            </label>

            <label htmlFor="exp-remind" className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                id="exp-remind"
                type="checkbox"
                name="remind"
                value="1"
                defaultChecked
                className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
              />
              <span>
                Remind me before it is due
                <span className="block text-xs text-muted-foreground">
                  Shows on this board and in the daily reminder.
                </span>
              </span>
            </label>

            <div className="flex items-center gap-2 pl-7">
              <Label htmlFor="exp-days" className="text-xs font-normal text-muted-foreground">
                How many days before
              </Label>
              <Input
                id="exp-days"
                name="remind_days"
                type="number"
                min={0}
                max={60}
                defaultValue={3}
                className="w-20"
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add expense
          </Button>
        </div>
      </form>
    </Modal>
  );
}
