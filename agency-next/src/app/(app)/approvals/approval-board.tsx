"use client";

/**
 * The WhatsApp approval board.
 *
 * Server-rendered on first paint, then kept live by Socket.IO. When an
 * approval arrives the affected row updates in place and the counts recompute
 * — no refetch, no page refresh.
 *
 * Realtime is an enhancement, never a requirement. With the service
 * unreachable the board still renders every row the server sent; it just stops
 * updating by itself, and says so rather than pretending to be live.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  MessageSquare,
  XCircle,
  Send,
  TriangleAlert,
  Wifi,
  WifiOff,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useWhatsAppSocket, type VideoUpdate } from "@/components/admin/use-whatsapp-socket";
import type { ApprovalRow, ApprovalCounts } from "@/lib/whatsapp-approvals";

const TONE: Record<string, { label: string; badge: "success" | "warning" | "danger" | "info" | "muted" }> = {
  queued: { label: "Queued", badge: "muted" },
  sending: { label: "Sending", badge: "muted" },
  sent: { label: "Sent", badge: "info" },
  delivered: { label: "Delivered", badge: "info" },
  viewed: { label: "Viewed", badge: "warning" },
  approved: { label: "Approved", badge: "success" },
  changes_requested: { label: "Changes requested", badge: "warning" },
  rejected: { label: "Rejected", badge: "danger" },
  failed: { label: "Failed to send", badge: "danger" },
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).getTime();
  if (Number.isNaN(ms)) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ApprovalBoard({
  initialRows,
  initialCounts,
  socketUrl,
}: {
  initialRows: ApprovalRow[];
  initialCounts: ApprovalCounts;
  socketUrl: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  /** Rows touched by a live event, so the change is visible rather than silent. */
  const [flashed, setFlashed] = useState<Set<number>>(new Set());
  const flashTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  /*
   * Server data wins on navigation — otherwise a filter change would be
   * overwritten by whatever the socket last pushed.
   *
   * Adjusted during render rather than in an effect: React's documented
   * pattern for "reset state when a prop changes". An effect would render the
   * stale rows once first, which shows the previous filter's results for a
   * frame.
   */
  const [seenInitial, setSeenInitial] = useState(initialRows);
  if (seenInitial !== initialRows) {
    setSeenInitial(initialRows);
    setRows(initialRows);
  }

  useEffect(() => {
    const timers = flashTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  function applyUpdate(update: VideoUpdate) {
    setRows((current) => {
      const index = current.findIndex(
        (r) =>
          (update.deliverableId != null && r.id === update.deliverableId) ||
          (update.videoCode != null && r.video_code === update.videoCode) ||
          // Delivery receipts identify the video only by the WhatsApp message
          // we sent, which is why the row carries that id.
          (update.waMessageId != null && r.wa_message_id === update.waMessageId)
      );
      // An update for a row this view doesn't hold — a different client's
      // video, or one sent since the page loaded. Ask the server rather than
      // inventing a row from a partial payload.
      if (index === -1) {
        router.refresh();
        return current;
      }

      const next = [...current];
      const row = { ...next[index] };
      if (update.waStatus) row.wa_status = update.waStatus;
      if (update.status) row.status = update.status;
      if (update.approvedBy !== undefined) row.wa_approved_by = update.approvedBy ?? null;
      if (update.comment !== undefined) row.wa_comment = update.comment ?? null;
      if (update.error !== undefined) row.wa_last_error = update.error ?? null;
      if (update.at) row.wa_responded_at = update.at;
      next[index] = row;

      const id = row.id;
      setFlashed((f) => new Set(f).add(id));
      const existing = flashTimers.current.get(id);
      if (existing) clearTimeout(existing);
      flashTimers.current.set(
        id,
        setTimeout(() => {
          setFlashed((f) => {
            const copy = new Set(f);
            copy.delete(id);
            return copy;
          });
          flashTimers.current.delete(id);
        }, 4000)
      );

      return next;
    });
  }

  const { connected } = useWhatsAppSocket(socketUrl, { onVideoUpdate: applyUpdate });

  // Recomputed from the live rows rather than trusting the server's snapshot,
  // so the cards and the table can never disagree on screen.
  const counts = useMemo<ApprovalCounts>(() => {
    const c = { pending: 0, approved: 0, changesRequested: 0, rejected: 0, readyToPost: 0, failed: 0 };
    for (const r of rows) {
      if (["queued", "sending", "sent", "delivered", "viewed"].includes(r.wa_status)) c.pending++;
      else if (r.wa_status === "approved") {
        c.approved++;
        if (r.status !== "posted") c.readyToPost++;
      } else if (r.wa_status === "changes_requested") c.changesRequested++;
      else if (r.wa_status === "rejected") c.rejected++;
      else if (r.wa_status === "failed") c.failed++;
    }
    return rows.length ? c : initialCounts;
  }, [rows, initialCounts]);

  const cards = [
    { key: "pending", label: "Awaiting client", value: counts.pending, icon: Clock, tone: "text-amber-600 dark:text-amber-400" },
    { key: "approved", label: "Approved", value: counts.approved, icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400" },
    { key: "changes", label: "Changes requested", value: counts.changesRequested, icon: MessageSquare, tone: "text-orange-600 dark:text-orange-400" },
    { key: "rejected", label: "Rejected", value: counts.rejected, icon: XCircle, tone: "text-rose-600 dark:text-rose-400" },
    { key: "ready", label: "Ready to post", value: counts.readyToPost, icon: Send, tone: "text-sky-600 dark:text-sky-400" },
    { key: "failed", label: "Failed to send", value: counts.failed, icon: TriangleAlert, tone: "text-rose-600 dark:text-rose-400" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">WhatsApp approvals</h2>
        {/* Stated plainly: a dashboard that has silently stopped updating is
            worse than one that admits it. */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
            connected
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-muted text-muted-foreground"
          )}
          title={
            connected
              ? "Connected — this page updates by itself"
              : "Not connected to the WhatsApp service. Refresh to see changes."
          }
        >
          {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {connected ? "Live" : "Not live"}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <Card key={c.key}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <c.icon className={cn("h-4 w-4", c.tone)} />
              </div>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums">{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing sent for WhatsApp approval yet. Open a finished video and choose{" "}
              <b>Send for approval</b>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Code</th>
                    <th className="px-3 py-2 text-left font-medium">Video</th>
                    <th className="px-3 py-2 text-left font-medium">Client</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Who replied</th>
                    <th className="px-3 py-2 text-left font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const tone = TONE[r.wa_status] ?? { label: r.wa_status, badge: "muted" as const };
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b border-border transition-colors duration-700 last:border-0",
                          flashed.has(r.id) && "bg-primary/5"
                        )}
                      >
                        <td className="px-4 py-2 font-mono text-xs font-medium">
                          {r.video_code ?? "—"}
                        </td>
                        <td className="max-w-[20rem] px-3 py-2">
                          <Link
                            href={`/deliverables/${r.id}`}
                            className="flex items-center gap-1.5 hover:text-primary"
                          >
                            <span className="min-w-0 truncate">{r.title}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                          </Link>
                          {r.wa_comment ? (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              “{r.wa_comment}”
                            </p>
                          ) : null}
                          {r.wa_last_error ? (
                            <p className="mt-0.5 text-xs text-destructive">{r.wa_last_error}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.company_name}</td>
                        <td className="px-3 py-2">
                          <Badge tone={tone.badge}>{tone.label}</Badge>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {r.wa_approved_by ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {timeAgo(r.wa_responded_at ?? r.wa_sent_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
