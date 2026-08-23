"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Plus, Pencil, Trash2, Loader2, Phone, Mail, AlarmClock, UserPlus } from "lucide-react";
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
import {
  LEAD_STAGES,
  LEAD_SOURCES,
  sourceLabel,
  isOverdue,
  isDueToday,
  type Lead,
} from "@/lib/lead-stages";
import { BAND_TEXT, type LeadScore } from "@/lib/lead-score";
import { saveLeadAction, moveLeadAction, snoozeLeadAction, deleteLeadAction } from "./actions";

type Owner = { id: number; name: string };

/**
 * The pipeline, as a list rather than as a board of draggable cards.
 *
 * Columns of cards look like a CRM and read like a puzzle: the thing anybody
 * actually needs off this screen is "who am I chasing today", and that is a
 * list sorted by follow-up date. The stage lives in a dropdown on the row, so
 * moving a lead is one click from the same place you read it.
 */
export function LeadBoard({
  leads,
  owners,
  today,
  scores,
  canDelete,
}: {
  leads: Lead[];
  owners: Owner[];
  /** Computed on the server, one per lead on this board. */
  scores: Record<number, LeadScore>;
  /** The database's today, so overdue is judged on its clock and not the browser's. */
  today: string;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState<Lead | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-medium">The pipeline</h2>
          <p className="text-xs text-muted-foreground">
            Whoever is overdue first, then by the day they are due.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add a lead
        </Button>
      </div>

      {leads.length === 0 ? (
        <p className="p-10 text-center text-sm text-muted-foreground">
          Nothing in the pipeline. Add the enquiries sitting in your DMs — the point of this board
          is that none of them go quiet without somebody noticing.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table dense>
            <THead>
              <tr>
                <th className="w-20">Score</th>
                <th>Name</th>
                <th className="hidden w-32 md:table-cell">Contact</th>
                <th className="hidden w-24 lg:table-cell">Source</th>
                <th className="w-36">Stage</th>
                <th className="hidden w-24 text-right lg:table-cell">Value</th>
                <th className="hidden w-28 xl:table-cell">Owner</th>
                <th className="w-28">Follow up</th>
                <th className="w-20 text-right">Actions</th>
              </tr>
            </THead>
            <TBody>
              {leads.map((l) => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  today={today}
                  score={scores[l.id]}
                  canDelete={canDelete}
                  onEdit={() => setEditing(l)}
                />
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <LeadForm
        open={adding}
        onClose={() => setAdding(false)}
        owners={owners}
        today={today}
      />
      <LeadForm
        key={editing?.id ?? "none"}
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        owners={owners}
        today={today}
        lead={editing ?? undefined}
      />
    </Card>
  );
}

function LeadRow({
  lead,
  today,
  score,
  canDelete,
  onEdit,
}: {
  lead: Lead;
  today: string;
  score?: LeadScore;
  canDelete: boolean;
  onEdit: () => void;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      toast({
        title: res.ok ? (res.message ?? "Done.") : (res.error ?? "That didn't work."),
        tone: res.ok ? undefined : "error",
      });
    });

  const late = isOverdue(lead.next_follow_up, today);
  const now = isDueToday(lead.next_follow_up, today);

  return (
    <TR className={late ? "bg-destructive/5" : undefined}>
      <TD>
        {score ? (
          <span
            // The reasons are the score. A number nobody can interrogate is a
            // number people work around rather than with, so every point is on
            // the hover.
            title={
              score.reasons.length
                ? score.reasons.map((r) => `${r.delta > 0 ? "+" : ""}${r.delta}  ${r.label}`).join("\n")
                : score.summary
            }
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
              score.band === "hot"
                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                : score.band === "warm"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {score.score}
            <span className="font-normal opacity-80">{BAND_TEXT[score.band]}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TD>
      <TD>
        <span className="font-medium">{lead.name}</span>
        {lead.company ? (
          <span className="block truncate text-xs text-muted-foreground">{lead.company}</span>
        ) : null}
        {/* What the hidden columns were carrying, folded under the name on a
            phone — the same shape the task boards use. */}
        <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
          {[lead.client_name, lead.phone || lead.email, sourceLabel(lead.source), lead.owner_name]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {/* Why this one is where it is — the single most useful thing on the
            row, so it is not left to a hover a phone cannot do. */}
        {score?.summary ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{score.summary}</span>
        ) : null}
      </TD>

      <TD className="hidden md:table-cell">
        {lead.phone ? (
          <a href={`tel:${lead.phone}`} className="flex items-center gap-1 text-xs hover:text-primary">
            <Phone className="h-3 w-3 shrink-0" /> {lead.phone}
          </a>
        ) : null}
        {lead.email ? (
          <a
            href={`mailto:${lead.email}`}
            className="flex items-center gap-1 truncate text-xs hover:text-primary"
          >
            <Mail className="h-3 w-3 shrink-0" /> {lead.email}
          </a>
        ) : null}
      </TD>

      <TD className="hidden lg:table-cell">
        <span className="text-xs text-muted-foreground">{sourceLabel(lead.source)}</span>
      </TD>

      <TD>
        <Select
          aria-label={`Stage for ${lead.name}`}
          value={lead.stage}
          disabled={pending}
          onChange={(e) => run(() => moveLeadAction(lead.id, e.target.value))}
          className="h-8 w-full text-xs"
        >
          {LEAD_STAGES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
        {lead.stage === "lost" && lead.lost_reason ? (
          <span className="mt-1 block text-xs text-muted-foreground">{lead.lost_reason}</span>
        ) : null}
      </TD>

      <TD className="hidden text-right tabular-nums lg:table-cell">
        {lead.value ? money(lead.value) : <span className="text-muted-foreground">—</span>}
      </TD>

      <TD className="hidden xl:table-cell">
        <span className="text-xs">{lead.owner_name ?? "—"}</span>
      </TD>

      <TD>
        {lead.next_follow_up ? (
          <Badge tone={late ? "danger" : now ? "warning" : "muted"}>
            {late ? "Overdue " : ""}
            {fmtDate(lead.next_follow_up)}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not planned</span>
        )}
      </TD>

      <TD className="text-right">
        <div className="flex items-center justify-end gap-1">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <button
            type="button"
            title="Follow up in 3 days"
            aria-label={`Snooze ${lead.name} for three days`}
            disabled={pending}
            onClick={() => run(() => snoozeLeadAction(lead.id, 3))}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <AlarmClock className="h-3.5 w-3.5" />
          </button>
          {lead.stage === "won" ? (
            <Link
              href={`/clients/new?lead=${lead.id}`}
              title="Create the client from this lead"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <UserPlus className="h-3.5 w-3.5" />
            </Link>
          ) : null}
          <button
            type="button"
            title="Edit"
            aria-label={`Edit ${lead.name}`}
            onClick={onEdit}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {canDelete ? (
            <button
              type="button"
              title="Delete"
              aria-label={`Delete ${lead.name}`}
              disabled={pending}
              onClick={() => {
                if (confirm(`Delete ${lead.name}? Marking them lost keeps the reason.`)) {
                  run(() => deleteLeadAction(lead.id));
                }
              }}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </TD>
    </TR>
  );
}

function LeadForm({
  open,
  onClose,
  owners,
  today,
  lead,
}: {
  open: boolean;
  onClose: () => void;
  owners: Owner[];
  today: string;
  lead?: Lead;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const uid = lead ? `l${lead.id}` : "new";

  const submit = (fd: FormData) =>
    start(async () => {
      const res = await saveLeadAction({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Saved." });
        onClose();
      } else {
        toast({ title: res.error ?? "Could not save it.", tone: "error" });
      }
    });

  return (
    <Modal open={open} onClose={onClose} title={lead ? lead.name : "Add a lead"}>
      <form action={submit} className="flex min-h-0 flex-1 flex-col">
        {lead ? <input type="hidden" name="id" value={lead.id} /> : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-name`}>Name</Label>
              <Input id={`${uid}-name`} name="name" required defaultValue={lead?.name ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-company`}>Business</Label>
              <Input
                id={`${uid}-company`}
                name="company"
                defaultValue={lead?.company ?? ""}
                placeholder="Cafe / clinic / boutique"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-phone`}>Phone</Label>
              <Input
                id={`${uid}-phone`}
                name="phone"
                inputMode="tel"
                defaultValue={lead?.phone ?? ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-email`}>Email</Label>
              <Input
                id={`${uid}-email`}
                name="email"
                type="email"
                defaultValue={lead?.email ?? ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-source`}>Where they came from</Label>
              <Select id={`${uid}-source`} name="source" defaultValue={lead?.source ?? "instagram"}>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {sourceLabel(s)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-stage`}>Stage</Label>
              <Select id={`${uid}-stage`} name="stage" defaultValue={lead?.stage ?? "new"}>
                {LEAD_STAGES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-value`}>Monthly value</Label>
              <Input
                id={`${uid}-value`}
                name="value"
                inputMode="decimal"
                defaultValue={lead?.value ? String(lead.value) : ""}
                placeholder="25,000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-owner`}>Who is chasing it</Label>
              <Select
                id={`${uid}-owner`}
                name="owner_user_id"
                defaultValue={lead?.owner_user_id ? String(lead.owner_user_id) : ""}
              >
                <option value="">Nobody yet</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-follow`}>Follow up on</Label>
              <Input
                id={`${uid}-follow`}
                name="next_follow_up"
                type="date"
                defaultValue={lead?.next_follow_up ?? today}
              />
              <p className="text-xs text-muted-foreground">
                A lead with no date on it is the one that goes quiet.
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-note`}>Notes</Label>
              <Textarea
                id={`${uid}-note`}
                name="note"
                rows={3}
                defaultValue={lead?.note ?? ""}
                placeholder="What they asked for, what was quoted, what they said."
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {lead ? "Save" : "Add lead"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
