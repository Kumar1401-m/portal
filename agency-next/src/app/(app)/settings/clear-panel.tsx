"use client";

import { useActionState } from "react";
import { Trash2, TriangleAlert, Check, Loader2 } from "lucide-react";
import { clearVideoDataAction, type ClearState } from "./clear-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { buttonClasses } from "@/components/ui/button";

/**
 * Clearing every video, for starting a real client list after testing.
 *
 * Written to be read before it is used: it says what goes, says what stays,
 * and shows the counts, because the number of videos about to be destroyed is
 * the one fact that decides whether this is the right button.
 */
export function ClearVideoDataPanel({ videos, files }: { videos: number; files: number }) {
  const [state, action, pending] = useActionState<ClearState, FormData>(clearVideoDataAction, {});

  const nothingToDo = videos === 0 && !state.ok;

  return (
    <Card className="border-[color-mix(in_srgb,var(--destructive)_35%,var(--border))]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 className="h-5 w-5 text-destructive" />
          Clear all video data
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          For starting fresh with real clients after a spell of testing.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive">Deleted</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              <li>
                <b className="tabular-nums text-foreground">{videos}</b> videos and posters
              </li>
              <li>captions, AI analysis, scripts, thumbnails</li>
              <li>approvals, feedback, comments</li>
              <li>publish attempts and the WhatsApp transcript</li>
              <li>
                <b className="tabular-nums text-foreground">{files}</b> video files in storage
              </li>
            </ul>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium">Kept</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              <li>clients, and their WhatsApp group links</li>
              <li>users and their logins</li>
              <li>invoices and payments</li>
              <li>settings, services and categories</li>
            </ul>
          </div>
        </div>

        {state.ok && state.summary ? (
          <div className="space-y-1 rounded-md border border-success/40 bg-success/5 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-success">
              <Check className="h-4 w-4" /> Cleared.
            </p>
            <p className="text-muted-foreground">
              {state.summary.rows.deliverables ?? 0} videos removed,{" "}
              {state.summary.filesDeleted} files deleted from storage
              {state.summary.filesFailed > 0
                ? `, ${state.summary.filesFailed} the bucket wouldn't remove`
                : ""}
              .
            </p>
          </div>
        ) : null}

        {state.error ? (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}

        {nothingToDo ? (
          <p className="text-xs text-muted-foreground">Nothing to clear — there are no videos.</p>
        ) : (
          <form action={action} className="flex flex-wrap items-center gap-2">
            <Input
              name="confirm"
              placeholder="Type DELETE"
              className="h-9 w-40"
              autoComplete="off"
              aria-label="Type DELETE to confirm"
            />
            <button
              type="submit"
              disabled={pending}
              className={buttonClasses({ variant: "destructive", size: "sm" })}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {pending ? "Clearing…" : "Clear all video data"}
            </button>
            <span className="text-xs text-muted-foreground">This cannot be undone.</span>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
