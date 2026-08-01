"use client";

import { useActionState } from "react";
import { RefreshCw, Loader2, TriangleAlert, Check } from "lucide-react";
import { syncAnalyticsAction, type SyncState } from "./actions";
import { buttonClasses } from "@/components/ui/button";

/**
 * Pulls a client's Instagram history on demand.
 *
 * The nightly job only covers yesterday, so a freshly connected account has
 * nothing to show until the next morning. This closes that gap: click it and
 * the last 30 days are fetched, stored and charted straight away.
 *
 * Deliberately verbose about the outcome. A sync can half-succeed — followers
 * and posts arrive while reach stays zero because the token lacks one
 * permission — and "done ✓" over a dashboard still full of zeros is how
 * someone concludes the whole feature is broken.
 */
export function SyncButton({
  clientId,
  label = "Analyse now",
}: {
  clientId: number;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState<SyncState, FormData>(syncAnalyticsAction, {
    ok: false,
  });

  return (
    <div className="space-y-2">
      <form action={formAction}>
        <input type="hidden" name="client_id" value={clientId} />
        <button
          type="submit"
          disabled={pending}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
          title="Fetch this client's Instagram history now, instead of waiting for the nightly job"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {pending ? "Reading Instagram…" : label}
        </button>
      </form>

      {state.error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{state.error}</span>
        </p>
      ) : null}

      {state.ok && state.message ? (
        <p className="flex items-start gap-1.5 text-xs text-success">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{state.message}</span>
        </p>
      ) : null}

      {state.warnings?.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}
    </div>
  );
}
