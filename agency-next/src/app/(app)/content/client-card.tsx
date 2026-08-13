"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Building2,
  Check,
  ChevronDown,
  Loader2,
  MessageCircle,
  PenLine,
  Send,
  Undo2,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { fmtDate } from "@/lib/utils";
import {
  saveBriefAction,
  sendContentAction,
  handToTeamAction,
  recordContentDecisionAction,
  type ContentState,
} from "./actions";

export type CardRow = {
  id: number;
  title: string;
  dueDate: string | null;
  description: string | null;
  assigneeName: string | null;
};

export type CardGroup = {
  clientId: number;
  companyName: string;
  hasGroup: boolean;
  approvesContent: boolean;
  toWrite: CardRow[];
  ready: CardRow[];
  withClient: CardRow[];
};

/**
 * One client's content, on one card.
 *
 * The board is grouped by client rather than listed by task because that is
 * how the work is done — you sit down with one client's month, write it, and
 * send it. A flat list of a hundred rows makes that a hundred decisions.
 *
 * Three states, in the order they happen: nothing written, written and ready
 * to go, gone and waiting on an answer.
 */
export function ClientCard({
  group,
  canSend,
}: {
  group: CardGroup;
  /** Sending to a client's group, and recording their answer, is a super admin's. */
  canSend: boolean;
}) {
  const [open, setOpen] = useState(group.toWrite.length > 0 || group.ready.length > 0);
  const total = group.toWrite.length + group.ready.length + group.withClient.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 text-left"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{group.companyName}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {total} {total === 1 ? "piece" : "pieces"}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {group.toWrite.length > 0 ? (
              <Badge tone="active">{group.toWrite.length} to write</Badge>
            ) : null}
            {group.ready.length > 0 ? (
              <Badge tone="info">{group.ready.length} ready to send</Badge>
            ) : null}
            {group.withClient.length > 0 ? (
              <Badge tone="warning">{group.withClient.length} with client</Badge>
            ) : null}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {!group.approvesContent ? (
          <p className="mt-1.5 pl-7 text-xs text-muted-foreground">
            This client does not sign content off — written briefs go straight to the team.
          </p>
        ) : !group.hasGroup ? (
          <p className="mt-1.5 pl-7 text-xs text-warning">
            No WhatsApp group linked, so content cannot be sent. Add one under Settings → WhatsApp.
          </p>
        ) : null}
      </CardHeader>

      {open ? (
        <CardContent className="space-y-4 pt-0">
          <WriteList rows={[...group.toWrite, ...group.ready]} />
          {/* Handing work to our own team is not the same act as putting
              something in front of a client, so it is not held to the same
              rule — otherwise an admin who wrote the month has nowhere to
              take it. */}
          {group.ready.length > 0 && (canSend || !group.approvesContent) ? (
            <SendBar group={group} />
          ) : group.ready.length > 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              {group.ready.length} ready to go out. A super admin sends content to the client.
            </p>
          ) : null}
          {group.withClient.length > 0 ? (
            <WithClient group={group} canSend={canSend} />
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/** The briefs themselves, each one editable where it sits. */
function WriteList({ rows }: { rows: CardRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <BriefRow key={r.id} row={r} />
      ))}
    </div>
  );
}

function BriefRow({ row }: { row: CardRow }) {
  const written = Boolean((row.description ?? "").trim());
  const [editing, setEditing] = useState(!written);
  const [body, setBody] = useState(row.description ?? "");
  const [saved, setSaved] = useState(written);
  const [pending, start] = useTransition();
  const toast = useToast();

  const save = () => {
    start(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(row.id));
      fd.set("description", body);
      const res: ContentState = await saveBriefAction({ ok: false }, fd);
      if (res.ok) {
        setSaved(Boolean(body.trim()));
        setEditing(false);
        toast({ title: "Content saved." });
      } else {
        toast({ title: res.error ?? "Could not save.", tone: "error" });
      }
    });
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/deliverables/${row.id}`}
            className="text-sm font-medium hover:text-primary hover:underline"
          >
            {row.title}
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.dueDate ? fmtDate(row.dueDate) : "no date"}
            {row.assigneeName ? ` · ${row.assigneeName}` : ""}
          </p>
        </div>
        {saved && !editing ? (
          <Badge tone="info">Written</Badge>
        ) : (
          <Badge tone="active">To write</Badge>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="The content for this piece, exactly as the client should read it."
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save
            </Button>
            {saved ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody(row.description ?? "");
                  setEditing(false);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            <PenLine className="h-3.5 w-3.5" /> Edit
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The send, which is the point of the board.
 *
 * All of them in one message by default, because that is how a month is
 * approved — a client reads the plan, not fifteen notifications. "One at a
 * time" is there for the piece that needed rewriting after the rest went.
 */
function SendBar({ group }: { group: CardGroup }) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [pending, start] = useTransition();
  const toast = useToast();
  const direct = !group.approvesContent;
  const ids = picking ? picked : group.ready.map((r) => r.id);
  const blocked = !direct && !group.hasGroup;

  const run = () => {
    if (ids.length === 0) return;
    start(async () => {
      const fd = new FormData();
      fd.set("client_id", String(group.clientId));
      for (const id of ids) fd.append("ids", String(id));
      const res: ContentState = direct
        ? await handToTeamAction({ ok: false }, fd)
        : await sendContentAction({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Sent." });
        setPicking(false);
        setPicked([]);
      } else {
        toast({ title: res.error ?? "Could not send.", tone: "error" });
      }
    });
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">{group.ready.length}</span>{" "}
          {group.ready.length === 1 ? "piece is" : "pieces are"} written and ready
          {direct ? " for the team." : " for the client."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={run} disabled={pending || blocked || ids.length === 0}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : direct ? (
              <Users className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {picking
              ? `Send ${picked.length} selected`
              : direct
                ? "Hand all to the team"
                : "Send all to the group"}
          </Button>
          {group.ready.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPicking((v) => !v);
                setPicked([]);
              }}
              disabled={pending}
            >
              {picking ? "Cancel" : "Pick one"}
            </Button>
          ) : null}
        </div>
      </div>

      {picking ? (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          {group.ready.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(r.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
                }
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {r.dueDate ? fmtDate(r.dueDate) : ""}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {blocked ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Link this client&apos;s WhatsApp group first, under Settings → WhatsApp.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Sent, and waiting on an answer — with the buttons to record one.
 *
 * A client replies in the group, in their own words. Nothing about "all good"
 * or a voice note presses a button, so the super admin reads it and records
 * it here. Without this the content gate could only be opened one task at a
 * time from fifteen separate task pages.
 */
function WithClient({ group, canSend }: { group: CardGroup; canSend: boolean }) {
  const [picked, setPicked] = useState<number[]>(group.withClient.map((r) => r.id));
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  const decide = (decision: "approved" | "changes_requested") => {
    if (picked.length === 0) {
      toast({ title: "Tick at least one piece.", tone: "error" });
      return;
    }
    if (decision === "changes_requested" && !reason.trim()) {
      setAsking(true);
      return;
    }
    start(async () => {
      const fd = new FormData();
      fd.set("decision", decision);
      if (reason.trim()) fd.set("reason", reason.trim());
      for (const id of picked) fd.append("ids", String(id));
      const res: ContentState = await recordContentDecisionAction({ ok: false }, fd);
      if (res.ok) {
        toast({ title: res.message ?? "Recorded." });
        setReason("");
        setAsking(false);
      } else {
        toast({ title: res.error ?? "Could not record it.", tone: "error" });
      }
    });
  };

  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <MessageCircle className="h-4 w-4" />
        With {group.companyName} — {group.withClient.length}{" "}
        {group.withClient.length === 1 ? "piece" : "pieces"} awaiting their answer
      </p>

      <div className="mt-2 space-y-1.5">
        {group.withClient.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={picked.includes(r.id)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
              }
              className="h-4 w-4 accent-[var(--primary)]"
              disabled={!canSend}
            />
            <Link
              href={`/deliverables/${r.id}`}
              className="min-w-0 truncate hover:text-primary hover:underline"
            >
              {r.title}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground">
              {r.dueDate ? fmtDate(r.dueDate) : ""}
            </span>
          </label>
        ))}
      </div>

      {canSend ? (
        <>
          {asking ? (
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="What did they ask to be changed? This goes to whoever rewrites it."
              className="mt-2 text-sm"
            />
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => decide("approved")} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              They approved — release to the team
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide("changes_requested")}
              disabled={pending}
            >
              <Undo2 className="h-4 w-4" /> They asked for changes
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          A super admin records what the client answers.
        </p>
      )}
    </div>
  );
}
