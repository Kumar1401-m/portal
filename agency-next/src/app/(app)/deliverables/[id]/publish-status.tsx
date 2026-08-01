"use client";

import { useActionState } from "react";
import {
  Send,
  Loader2,
  RotateCw,
  ExternalLink,
  TriangleAlert,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { retryPublishAction, type RetryState } from "../actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";

export type PublishInfo = {
  instagramStatus: string;
  mediaId: string | null;
  permalink: string | null;
  postedAt: string | null;
  scheduledAt: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  autoPublishEnabled: boolean;
  hasInstagramAccount: boolean;
};

const TONE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  posted: "success",
  processing: "warning",
  scheduled: "warning",
  failed: "danger",
  not_posted: "muted",
};

const LABEL: Record<string, string> = {
  posted: "Live on Instagram",
  processing: "Publishing now",
  scheduled: "Waiting for its slot",
  failed: "Failed",
  not_posted: "Not scheduled",
};

/**
 * What the auto-publisher has done with this deliverable, and the one button
 * that matters when it went wrong.
 *
 * The retry exists because a failed post is otherwise invisible until someone
 * notices the client's feed is empty. `post_attempts` is what the queue's
 * budget check reads, so "try again" has to reset it — which is why this is a
 * server action and not a status change through the normal workflow control.
 */
export function PublishStatus({
  deliverableId,
  info,
}: {
  deliverableId: number;
  info: PublishInfo;
}) {
  const [state, formAction, pending] = useActionState<RetryState, FormData>(retryPublishAction, {
    ok: false,
  });

  const status = info.instagramStatus || "not_posted";
  const tone = TONE[status] ?? "muted";
  const isTerminal = status === "posted";
  const exhausted = status === "failed";

  // Nothing to show for a client who never opted in and has no post history.
  if (!info.hasInstagramAccount && status === "not_posted") return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Send className="h-5 w-5 text-muted-foreground" />
            Instagram
          </span>
          <Badge tone={tone}>{LABEL[status] ?? status}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!info.autoPublishEnabled && !isTerminal ? (
          <p className="flex items-start gap-2 text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Auto-publishing is off for this client, so nothing will post by itself. Turn it on
              from the client&apos;s edit page.
            </span>
          </p>
        ) : null}

        {info.scheduledAt && !isTerminal ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" />
            Scheduled for {info.scheduledAt}
          </p>
        ) : null}

        {isTerminal ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Published{info.postedAt ? ` on ${info.postedAt}` : ""}
            </p>
            {info.permalink ? (
              <a
                href={info.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View the post
              </a>
            ) : null}
            {info.mediaId ? (
              <p className="font-mono text-xs text-muted-foreground">Media id {info.mediaId}</p>
            ) : null}
          </div>
        ) : null}

        {info.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
            <p className="flex items-start gap-2 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{info.error}</span>
            </p>
          </div>
        ) : null}

        {info.attempts > 0 && !isTerminal ? (
          <p className="text-xs text-muted-foreground">
            {info.attempts} of {info.maxAttempts} attempts used
            {exhausted ? " — the automation has stopped trying." : "."}
          </p>
        ) : null}

        {!isTerminal && (exhausted || info.attempts > 0) ? (
          <form action={formAction}>
            <input type="hidden" name="deliverable_id" value={deliverableId} />
            <button type="submit" disabled={pending} className={buttonClasses({ size: "sm" })}>
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCw className="h-4 w-4" />
              )}
              Try posting again
            </button>
          </form>
        ) : null}

        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok ? (
          <p className="text-sm text-success">
            Back in the queue — the publisher picks it up within five minutes.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
