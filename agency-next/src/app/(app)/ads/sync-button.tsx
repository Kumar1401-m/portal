"use client";

import { useState, useTransition } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { syncAdsAction, syncOneClientAction, type SyncState } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Refresh from Meta on demand.
 *
 * The nightly job keeps the board current on its own; this is for the moment
 * someone is looking at a number and wants to know it is the number Meta has
 * right now — usually because a client has just asked about it.
 *
 * A per-client failure is shown as a dialog rather than a toast. "Reading
 * advertisements requires ads_read" is a sentence with a fix in it, and one
 * that fades in six seconds is one nobody acts on.
 */
export function SyncButton({
  clientId,
}: {
  /**
   * Refresh this client alone, from their own page.
   *
   * Omitted on the board, which refreshes the whole book. Offering the board's
   * button on one client's page would spend a Graph call per client and report
   * nine other people's token problems to somebody who came to look at one
   * account — so the scope follows the page, and it is the same button either
   * way rather than two that drift apart.
   */
  clientId?: number;
} = {}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<SyncState | null>(null);
  const toast = useToast();

  function run() {
    start(async () => {
      const res = clientId ? await syncOneClientAction(clientId) : await syncAdsAction();
      setState(res);
      toast(
        res.ok
          ? { title: "Refreshed from Meta", description: res.message }
          : {
              title: "Meta would not give us everything",
              // Meta's words, then what to do about them. The message alone
              // sends people to ask the client for a permission that is not
              // the problem.
              description:
                res.failures
                  ?.map((f) => `${f.client}: ${f.error}${f.hint ? `\n\n→ ${f.hint}` : ""}`)
                  .join("\n\n") || res.message,
              tone: "error",
              ack: true,
            }
      );
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={buttonClasses({ variant: "outline", size: "sm" })}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {pending ? "Refreshing…" : "Refresh from Meta"}
      </button>
      {/* Kept on screen after the toast has gone, because a list of clients
          whose tokens need attention is a to-do list, not a notification. */}
      {state?.failures?.length ? (
        <span className="sr-only" role="status">
          {state.failures.length} client{state.failures.length === 1 ? "" : "s"} failed to refresh.
        </span>
      ) : null}
    </>
  );
}
