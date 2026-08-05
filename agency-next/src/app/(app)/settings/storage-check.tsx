"use client";

import { useActionState } from "react";
import { Check, X, Loader2, PlugZap, ArrowRight } from "lucide-react";
import { testStorageAction, type StorageCheckState } from "./storage-actions";
import { buttonClasses } from "@/components/ui/button";

/**
 * "Test connection" for R2.
 *
 * Worth its own control because S3 auth failures are near-silent: the same
 * `SignatureDoesNotMatch` covers a wrong secret, a wrong account id and a
 * token without write permission. Showing which of the four steps broke —
 * and naming the field to fix — turns twenty minutes of guessing into one
 * correction.
 */
export function StorageCheck() {
  const [state, action, pending] = useActionState<StorageCheckState, FormData>(
    testStorageAction,
    { ran: false }
  );

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
          {pending ? "Testing…" : "Test connection"}
        </button>
      </form>

      {pending ? (
        <p className="text-xs text-muted-foreground">
          Uploading a small test file, reading it back, then deleting it.
        </p>
      ) : null}

      {state.ran ? (
        <div className="space-y-2">
          <p className={`text-sm font-medium ${state.ok ? "text-success" : "text-destructive"}`}>
            {state.ok
              ? "Storage is working — videos will upload."
              : "Storage isn't working yet."}
          </p>

          <ul className="space-y-1.5">
            {(state.steps ?? []).map((s) => (
              <li key={s.label} className="flex items-start gap-2 text-sm">
                {s.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <span className="min-w-0">
                  <span className={s.ok ? "" : "font-medium"}>{s.label}</span>
                  {s.detail ? (
                    <span className="block text-xs text-muted-foreground">{s.detail}</span>
                  ) : null}
                  {/* The actionable half — which field to go and change. */}
                  {s.fix ? (
                    <span className="mt-0.5 flex items-start gap-1 text-xs text-warning">
                      <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" />
                      {s.fix}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
