"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Check, ExternalLink } from "lucide-react";
import {
  getClientBoard,
  quickUpdateTask,
  type ClientBoard as Board,
  type ClientBoardTask,
} from "./client-board-actions";
import { Badge, statusTone } from "@/components/ui/badge";
import { SERVICES, serviceOf } from "@/lib/services";
import { buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { label, fmtDate } from "@/lib/utils";

function Tally({
  name,
  done,
  target,
  dot,
}: {
  name: string;
  done: number;
  target: number;
  dot?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {dot ? <span className={`h-2 w-2 rounded-full ${dot}`} /> : null}
        {name}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        {done}
        {target ? <span className="text-sm text-muted-foreground">/{target}</span> : null}
      </div>
    </div>
  );
}

/** One editable row: date and owner, saved on its own. */
function Row({ t, assignees }: { t: ClientBoardTask; assignees: { id: number; name: string }[] }) {
  const [due, setDue] = useState(t.due_date ? String(t.due_date).slice(0, 10) : "");
  const [who, setWho] = useState(t.assigned_to ? String(t.assigned_to) : "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty =
    due !== (t.due_date ? String(t.due_date).slice(0, 10) : "") ||
    who !== (t.assigned_to ? String(t.assigned_to) : "");

  const save = () =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("task_id", String(t.id));
      fd.set("due_date", due);
      fd.set("assigned_to", who);
      const res = await quickUpdateTask({ ok: false }, fd);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(res.error ?? "Could not save.");
      }
    });

  const svc = SERVICES[serviceOf(t)];

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-2 py-2">
        <Link
          href={`/deliverables/${t.id}`}
          className="inline-flex items-center gap-1 font-medium hover:text-primary hover:underline"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${svc.dot}`} />
          <span className="max-w-[13rem] truncate">{t.title}</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Link>
        <div className="pl-3.5 text-xs text-muted-foreground">
          {svc.short}
          {t.content_category ? ` · ${t.content_category}` : ""}
        </div>
      </td>
      <td className="px-2 py-2">
        <Badge tone={statusTone(t.status)}>{label(t.status)}</Badge>
      </td>
      <td className="px-2 py-2">
        <Input
          type="date"
          value={due}
          onChange={(e) => {
            setDue(e.target.value);
            setSaved(false);
          }}
          className="h-8 w-[9.5rem] text-xs"
        />
      </td>
      <td className="px-2 py-2">
        <Select
          value={who}
          onChange={(e) => {
            setWho(e.target.value);
            setSaved(false);
          }}
          className="h-8 w-36 text-xs"
        >
          <option value="">Unassigned</option>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">
        {t.scheduled_at ? fmtDate(t.scheduled_at) : "—"}
      </td>
      <td className="px-2 py-2 text-right">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
          title={dirty ? "Save this row" : "Nothing changed"}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : null}
          {saved ? "Saved" : "Save"}
        </button>
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </td>
    </tr>
  );
}

/**
 * The client's whole month, alongside the task you happen to be editing:
 * what they're owed against what's been produced, and every task with its
 * dates. Reschedule or hand over any of them without closing the editor.
 */
export function ClientBoard({ clientId }: { clientId: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied">("loading");

  useEffect(() => {
    let live = true;
    getClientBoard(clientId)
      .then((b) => {
        if (!live) return;
        if (b) {
          setBoard(b);
          setState("ready");
        } else {
          setState("denied");
        }
      })
      .catch(() => live && setState("denied"));
    return () => {
      live = false;
    };
  }, [clientId]);

  if (state === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the client&apos;s month…
      </div>
    );
  }
  if (state === "denied" || !board) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Couldn&apos;t load this client.</p>;
  }

  const target = board.video_target + board.poster_target;
  const completion = target ? Math.min(100, Math.round((board.approved / target) * 100)) : 0;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold">{board.company_name}</h3>
        <p className="text-sm text-muted-foreground">
          Delivered this month ({board.month}) — approved counts towards the target.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tally
          name="Videos"
          done={board.videos_done}
          target={board.video_target}
          dot={SERVICES.video_editing.dot}
        />
        <Tally
          name="Posters"
          done={board.posters_done}
          target={board.poster_target}
          dot={SERVICES.poster_designing.dot}
        />
        <Tally name="Approved" done={board.approved} target={board.total} />
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Completion</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500"
                style={{ width: `${completion}%` }}
              />
            </div>
            <span className="text-sm font-semibold tabular-nums">{completion}%</span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left font-semibold">Task</th>
              <th className="px-2 py-2 text-left font-semibold">Status</th>
              <th className="px-2 py-2 text-left font-semibold">Due</th>
              <th className="px-2 py-2 text-left font-semibold">Owner</th>
              <th className="px-2 py-2 text-left font-semibold">Posting</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {board.tasks.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
                  No tasks for this client yet.
                </td>
              </tr>
            ) : (
              board.tasks.map((t) => <Row key={t.id} t={t} assignees={board.assignees} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Dates and owners save row by row. Status moves stay in the task&apos;s workflow, so the
        approval steps and the client&apos;s notifications aren&apos;t skipped.
      </p>
    </div>
  );
}
