"use client";

import { useActionState } from "react";
import { Send, Loader2, Check, TriangleAlert, MessageCircle } from "lucide-react";
import { sendForApprovalAction, type SendState } from "../../approvals/whatsapp-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";

export type WaPanel = {
  videoCode: string | null;
  waStatus: string;
  groupName: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  approvedBy: string | null;
  comment: string | null;
  lastError: string | null;
  hasGroup: boolean;
  hasVideo: boolean;
};

const LABEL: Record<string, { text: string; tone: "success" | "warning" | "danger" | "info" | "muted" }> = {
  not_sent: { text: "Not sent", tone: "muted" },
  queued: { text: "Queued", tone: "muted" },
  sending: { text: "Sending", tone: "muted" },
  sent: { text: "Sent — awaiting reply", tone: "info" },
  delivered: { text: "Delivered", tone: "info" },
  viewed: { text: "Seen by client", tone: "warning" },
  approved: { text: "Approved", tone: "success" },
  changes_requested: { text: "Changes requested", tone: "warning" },
  rejected: { text: "Rejected", tone: "danger" },
  failed: { text: "Failed to send", tone: "danger" },
};

/**
 * Sending one video to its client's WhatsApp group, and what came back.
 *
 * The button is deliberately blocked — not just error-prone — when there is no
 * group or no uploaded video. Both produce a confusing failure inside
 * WhatsApp itself, and the reason is far clearer stated up front than returned
 * from a send that looked like it should work.
 */
export function SendApproval({
  deliverableId,
  panel,
}: {
  deliverableId: number;
  panel: WaPanel;
}) {
  const [state, formAction, pending] = useActionState<SendState, FormData>(
    sendForApprovalAction,
    { ok: false }
  );

  const status = LABEL[panel.waStatus] ?? { text: panel.waStatus, tone: "muted" as const };
  const settled = ["approved", "rejected"].includes(panel.waStatus);
  const blocked = !panel.hasGroup || !panel.hasVideo;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
            Client approval
          </span>
          <Badge tone={status.tone}>{status.text}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {panel.videoCode ? (
          <p className="text-muted-foreground">
            Video code <span className="font-mono font-medium text-foreground">{panel.videoCode}</span>
            {panel.groupName ? ` · ${panel.groupName}` : ""}
          </p>
        ) : null}

        {!panel.hasVideo ? (
          <p className="flex items-start gap-2 text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Upload the finished video first — WhatsApp needs the actual file to send.</span>
          </p>
        ) : null}

        {!panel.hasGroup ? (
          <p className="flex items-start gap-2 text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This client has no WhatsApp group linked yet. Add one under Settings → WhatsApp.
            </span>
          </p>
        ) : null}

        {panel.comment ? (
          <div className="rounded-md border border-border bg-muted/40 p-2.5">
            <p className="text-xs font-medium text-muted-foreground">The client wrote</p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm">{panel.comment}</p>
          </div>
        ) : null}

        {panel.approvedBy ? (
          <p className="text-xs text-muted-foreground">
            {panel.waStatus === "approved" ? "Approved" : "Answered"} by {panel.approvedBy}
            {panel.respondedAt ? ` · ${panel.respondedAt.slice(0, 16).replace("T", " ")}` : ""}
          </p>
        ) : null}

        {/* Clamped: this text is written by whatever failed, not by us, so its
            length is not something the panel can rely on. The full text stays
            available on hover. */}
        {panel.lastError ? (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="line-clamp-3" title={panel.lastError}>
              {panel.lastError}
            </span>
          </p>
        ) : null}

        {!settled ? (
          <form action={formAction}>
            <input type="hidden" name="deliverable_id" value={deliverableId} />
            <button
              type="submit"
              disabled={pending || blocked}
              className={buttonClasses({ size: "sm" })}
              title={
                blocked
                  ? "Needs an uploaded video and a linked WhatsApp group"
                  : "Send this video to the client's WhatsApp group"
              }
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {pending
                ? "Sending…"
                : panel.waStatus === "not_sent"
                  ? "Send for approval"
                  : "Send again"}
            </button>
          </form>
        ) : null}

        {state.error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}
        {state.ok && state.message ? (
          <p className="flex items-start gap-2 text-sm text-success">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.message}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
