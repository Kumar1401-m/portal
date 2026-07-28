"use client";

import { useActionState } from "react";
import { CheckCircle2, MessageSquare, Loader2 } from "lucide-react";
import {
  clientApprove,
  clientRequestChanges,
  type PortalActionState,
} from "../../actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const INIT: PortalActionState = { ok: false };

export function PortalReview({ deliverableId }: { deliverableId: number }) {
  const [approveState, approve, approving] = useActionState(clientApprove, INIT);
  const [changesState, requestChanges, requesting] = useActionState(clientRequestChanges, INIT);

  const done = approveState.ok || changesState.ok;
  const message = approveState.message || changesState.message;

  if (done) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-5 text-success">
          <CheckCircle2 className="h-5 w-5" />
          <p className="text-sm font-medium">{message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <form action={approve}>
          <input type="hidden" name="deliverable_id" value={deliverableId} />
          <Button type="submit" size="lg" className="w-full" disabled={approving}>
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve
          </Button>
          {approveState.error ? (
            <p className="mt-2 text-sm text-destructive">{approveState.error}</p>
          ) : null}
        </form>

        <div className="relative text-center">
          <span className="bg-card px-3 text-xs uppercase tracking-wide text-muted-foreground">or</span>
          <div className="absolute inset-x-0 top-1/2 -z-10 h-px bg-border" />
        </div>

        <form action={requestChanges} className="space-y-2">
          <input type="hidden" name="deliverable_id" value={deliverableId} />
          <label className="flex items-center gap-2 text-sm font-medium">
            <MessageSquare className="h-4 w-4 text-muted-foreground" /> Request a change
          </label>
          <Textarea name="reason" rows={3} placeholder="Tell us what you'd like changed…" />
          <Button type="submit" variant="outline" className="w-full" disabled={requesting}>
            {requesting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Request changes
          </Button>
          {changesState.error ? (
            <p className="text-sm text-destructive">{changesState.error}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
