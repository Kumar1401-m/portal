"use client";

import { useActionState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { changeStatusAction, type StatusState } from "../actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { label } from "@/lib/utils";
import { EDITOR_STATUSES } from "@/lib/constants";
import { buttonClasses } from "@/components/ui/button";

type Variant = "default" | "outline" | "destructive";
type Action = { label: string; status: string; variant?: Variant; reason?: boolean };

const NEXT: Record<string, Action[]> = {
  pending: [{ label: "Move to content review", status: "content_review" }],
  content_review: [{ label: "Approve content", status: "approved" }],
  waiting_for_raw: [{ label: "Mark raw uploaded", status: "raw_uploaded" }],
  raw_uploaded: [{ label: "Start editing", status: "editing" }],
  // Named for where it goes, not for the column it sets. An editor pressing
  // this is handing the work over, and "caption ready" never said to whom.
  editing: [{ label: "Send to super admin for review", status: "caption_ready" }],
  caption_ready: [{ label: "Send for final review", status: "review" }],
  review: [{ label: "Approve", status: "approved" }],
  changes_requested: [{ label: "Mark resolved", status: "resolved" }],
  resolved: [{ label: "Send for final review", status: "review" }],
  approved: [
    { label: "Schedule", status: "scheduled" },
    { label: "Mark posted", status: "posted" },
  ],
  scheduled: [{ label: "Mark posted", status: "posted" }],
  posted: [{ label: "Mark completed", status: "completed" }],
  completed: [],
  rejected: [{ label: "Reopen", status: "content_review" }],
  cancelled: [{ label: "Reopen", status: "content_review" }],
};

/**
 * Putting something in front of a client is restricted to super_admin and crm.
 *
 * Only the finished piece now. Content review used to be here too, back when
 * a client signed the copy off; it is an internal step now and anyone who can
 * move the task can move it.
 */
const SEND_TO_CLIENT_STATUSES = ["review"];

function actionsFor(status: string, canSendToClient: boolean, editingOnly: boolean): Action[] {
  // Copied, not referenced: NEXT is a module-level constant shared by every
  // render on the server, and callers must not be able to mutate it.
  const out = (NEXT[status] || [])
    .filter((a) => canSendToClient || !SEND_TO_CLIENT_STATUSES.includes(a.status))
    .map((a) => ({ ...a }));
  if (["content_review", "review"].includes(status)) {
    out.push({ label: "Request changes", status: "changes_requested", variant: "outline", reason: true });
  }
  if (!["completed", "cancelled", "rejected"].includes(status)) {
    out.push({ label: "Reject", status: "rejected", variant: "destructive", reason: true });
    out.push({ label: "Cancel", status: "cancelled", variant: "outline", reason: true });
  }
  // An editor sees only the buttons that would actually work. The server
  // refuses the rest either way; showing them would just be a promise the
  // portal breaks on click.
  return editingOnly
    ? out.filter((a) => (EDITOR_STATUSES as string[]).includes(a.status))
    : out;
}

export function WorkflowControls({
  deliverableId,
  status,
  canSendToClient,
  editingOnly = false,
}: {
  deliverableId: number;
  status: string;
  canSendToClient: boolean;
  /** True for a video editor: the edit's own stages, nothing beyond them. */
  editingOnly?: boolean;
}) {
  const [state, formAction, pending] = useActionState<StatusState, FormData>(
    changeStatusAction,
    { ok: false }
  );
  const actions = actionsFor(status, canSendToClient, editingOnly);
  const needsReason = actions.some((a) => a.reason);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
            Workflow
          </span>
          <Badge tone={statusTone(status)}>{label(status)}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="deliverable_id" value={deliverableId} />

          {needsReason ? (
            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason / note</Label>
              <Textarea
                id="reason"
                name="reason"
                rows={3}
                placeholder="Required when requesting changes, rejecting or cancelling."
              />
            </div>
          ) : null}

          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">This item is complete — no further actions.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <button
                  key={a.status + a.label}
                  type="submit"
                  name="status"
                  value={a.status}
                  disabled={pending}
                  className={buttonClasses({
                    variant: a.variant ?? "default",
                    size: "sm",
                  })}
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {a.label}
                </button>
              ))}
            </div>
          )}

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.ok && state.effective ? (
            <p className="text-sm text-success">
              Moved to {label(state.effective)} ✓
            </p>
          ) : null}
          {/* It worked, and it still will not do what you expect. Shown next
              to the success line rather than instead of it, because both are
              true and hiding either one misleads. */}
          {state.ok && state.warning ? (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{state.warning}</span>
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
