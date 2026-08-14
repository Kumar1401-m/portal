"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Building2,
  Home,
  Check,
  ChevronDown,
  Loader2,
  MessageCircle,
  Send,
  Undo2,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { fmtDate } from "@/lib/utils";
import { BriefRow, type CardRow } from "./brief-row";
import {
  sendContentAction,
  handToTeamAction,
  recordContentDecisionAction,
  type ContentState,
} from "./actions";

export type { CardRow };

export type CardProperty = {
  name: string;
  toWrite: CardRow[];
  ready: CardRow[];
  withClient: CardRow[];
};

export type CardGroup = {
  clientId: number;
  companyName: string;
  hasGroup: boolean;
  approvesContent: boolean;
  properties: CardProperty[];
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
        <CardContent className="space-y-5 pt-0">
          {/*
            One section per property, because that is the unit a client reads
            and answers in: four posts about this flat, six about that one.
            Each carries its own send, so "just this property" needs no ticking.

            A client with nothing but unnamed content gets one unheaded
            section — the grouping should not announce itself where there is
            nothing to group.
          */}
          {group.properties.map((p) => (
            <PropertySection
              key={p.name || "__none"}
              group={group}
              property={p}
              canSend={canSend}
              showHeading={group.properties.length > 1 || Boolean(p.name)}
            />
          ))}

          {/* And the whole month at once, for the client who is sent the plan
              rather than each property as it comes up. */}
          {group.properties.length > 1 && group.ready.length > 0 && (canSend || !group.approvesContent) ? (
            <SendBar group={group} rows={group.ready} label="everything above" />
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One property's content: its briefs, its own send, its own answer panel.
 *
 * Self-contained on purpose. A client with six properties is six of these,
 * and each is a complete piece of work — write it, send it, record what came
 * back — without ticking anything or scrolling to a shared button.
 */
function PropertySection({
  group,
  property,
  canSend,
  showHeading,
}: {
  group: CardGroup;
  property: CardProperty;
  canSend: boolean;
  showHeading: boolean;
}) {
  const name = property.name || "No property";
  const label = property.name ? `${property.name}'s content` : "these";

  return (
    <section className="space-y-3">
      {showHeading ? (
        <div className="flex items-center gap-2 border-b border-border pb-1.5">
          <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h3>
          <span className="shrink-0 text-xs text-muted-foreground">
            {property.toWrite.length + property.ready.length + property.withClient.length}
          </span>
        </div>
      ) : null}

      <WriteList rows={[...property.toWrite, ...property.ready]} />

      {/* Handing work to our own team is not the same act as putting something
          in front of a client, so it is not held to the same rule — otherwise
          an admin who wrote the month has nowhere to take it. */}
      {property.ready.length > 0 && (canSend || !group.approvesContent) ? (
        <SendBar group={group} rows={property.ready} label={label} />
      ) : property.ready.length > 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {property.ready.length} ready to go out. A super admin sends content to the client.
        </p>
      ) : null}

      {property.withClient.length > 0 ? (
        <WithClient group={group} rows={property.withClient} canSend={canSend} />
      ) : null}
    </section>
  );
}

/** The briefs themselves — a line each, written in a popup. */
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


/* ------------------------------------------------------------------ */

/**
 * The send, which is the point of the board.
 *
 * All of them in one message by default, because that is how a month is
 * approved — a client reads the plan, not fifteen notifications. "One at a
 * time" is there for the piece that needed rewriting after the rest went.
 */
function SendBar({
  group,
  rows,
  label,
}: {
  group: CardGroup;
  /** Exactly what this bar sends — one property's, or the client's whole month. */
  rows: CardRow[];
  /** Named on the button, so two bars on one card cannot be confused. */
  label: string;
}) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [pending, start] = useTransition();
  const toast = useToast();
  const direct = !group.approvesContent;
  const ids = picking ? picked : rows.map((r) => r.id);
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
          <span className="font-medium">{rows.length}</span>{" "}
          {rows.length === 1 ? "piece is" : "pieces are"} written and ready
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
                ? `Hand ${label} to the team`
                : `Send ${label} to the group`}
          </Button>
          {rows.length > 1 ? (
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
          {rows.map((r) => (
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
function WithClient({
  group,
  rows,
  canSend,
}: {
  group: CardGroup;
  /** This property's pieces, not the client's whole month. */
  rows: CardRow[];
  canSend: boolean;
}) {
  const [picked, setPicked] = useState<number[]>(rows.map((r) => r.id));
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
        With {group.companyName} — {rows.length}{" "}
        {rows.length === 1 ? "piece" : "pieces"} awaiting their answer
      </p>

      <div className="mt-2 space-y-1.5">
        {rows.map((r) => (
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
