"use client";

import { useActionState, useState, useTransition } from "react";
import {
  Send,
  Loader2,
  RotateCw,
  ExternalLink,
  TriangleAlert,
  Clock,
  CheckCircle2,
  Zap,
} from "lucide-react";
import { retryPublishAction, postNowAction, type RetryState } from "../actions";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";

export type PublishInfo = {
  instagramStatus: string;
  mediaId: string | null;
  permalink: string | null;
  postedAt: string | null;
  /** Already rendered in the client's own clock by the server. */
  scheduledAt: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  autoPublishEnabled: boolean;
  hasInstagramAccount: boolean;
  /** Every reason this video cannot post by itself, in plain words. */
  blockers: string[];
  /** When the publisher will next look, given nothing is blocking it. */
  nextLook: string | null;
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
  canPostNow = false,
}: {
  deliverableId: number;
  info: PublishInfo;
  /** Super admin only — this puts a post on a live client account at once. */
  canPostNow?: boolean;
}) {
  const [state, formAction, pending] = useActionState<RetryState, FormData>(retryPublishAction, {
    ok: false,
  });
  const [posting, startPost] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();

  /*
   * Two clicks, not one.
   *
   * Everything else on this page can be undone from inside the portal. This
   * puts a video on a client's public Instagram account the moment it is
   * pressed, and the only way back is to delete the post — from Instagram,
   * where the people who saw it already have.
   */
  function postNow() {
    startPost(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(deliverableId));
      const res = await postNowAction({ ok: false }, fd);
      setConfirming(false);
      toast(
        res.ok
          ? { title: "Posted to Instagram", description: res.permalink || "It's live now." }
          : {
              title: res.pending ? "Instagram is still encoding it" : "Couldn't post it",
              description: res.error,
              tone: res.pending ? "success" : "error",
            }
      );
    });
  }

  const status = info.instagramStatus || "not_posted";
  const tone = TONE[status] ?? "muted";
  const isTerminal = status === "posted";
  const exhausted = status === "failed";

  /*
   * This used to return null when the client had no Instagram account and the
   * video had never been scheduled — which is precisely the case where someone
   * is standing there asking why it did not post. The panel vanished rather
   * than answering, and the answer was one line: no account is linked.
   *
   * It now always renders for a video, and leads with whatever is stopping it.
   */

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
        {/* Everything standing between this video and Instagram, listed. The
            publisher tests several conditions and returns silently when any
            one fails, so the only place they can be seen together is here. */}
        {info.blockers.length > 0 && !isTerminal ? (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5">
            <p className="flex items-start gap-2 text-xs font-medium">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                This won&apos;t post by itself
                {info.blockers.length === 1 ? "" : ` — ${info.blockers.length} things need fixing`}:
              </span>
            </p>
            <ul className="mt-1.5 space-y-1 pl-6">
              {info.blockers.map((b) => (
                <li key={b} className="list-disc text-xs text-muted-foreground">
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {info.scheduledAt && !isTerminal ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" />
            <span>
              Due at <span className="font-medium text-foreground">{info.scheduledAt}</span>
              {info.nextLook ? ` · ${info.nextLook}` : ""}
            </span>
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

        {/* Offered for anything not already live, rather than only after an
            attempt has been made. A video sitting at "not scheduled" with zero
            attempts is the most stuck a video can be, and it was the one case
            with no button — the state that most needs a push had none. */}
        {!isTerminal ? (
          <div className="flex flex-wrap items-center gap-2">
            <form action={formAction}>
              <input type="hidden" name="deliverable_id" value={deliverableId} />
              <button
                type="submit"
                disabled={pending || posting}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCw className="h-4 w-4" />
                )}
                {info.attempts > 0 ? "Try again at its slot" : "Put it in the queue"}
              </button>
            </form>

            {/* Skips the clock, not the requirements: without an account or a
                video there is still nothing to send, and the panel says so
                above rather than letting this fail. */}
            {canPostNow ? (
              confirming ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={postNow}
                    disabled={posting}
                    className={buttonClasses({ size: "sm" })}
                  >
                    {posting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    {posting ? "Posting…" : "Yes — post it live"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={posting}
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={posting}
                  className={buttonClasses({ size: "sm" })}
                  title="Publish to the client's Instagram account immediately"
                >
                  <Zap className="h-4 w-4" /> Post now
                </button>
              )
            ) : null}
          </div>
        ) : null}

        {confirming ? (
          <p className="text-xs text-muted-foreground">
            This goes on {info.hasInstagramAccount ? "the client's" : "their"} Instagram account
            straight away, without waiting for its slot. It can only be removed from Instagram.
          </p>
        ) : null}

        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok ? (
          <p className="text-sm text-success">
            {info.blockers.length
              ? "Queued — but fix the points above or the publisher will still skip it."
              : "Queued. The publisher looks every 15 minutes."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
