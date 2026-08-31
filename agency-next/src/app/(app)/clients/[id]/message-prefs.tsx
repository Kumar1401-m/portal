"use client";

import { useActionState } from "react";
import { Check, BellRing, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveMessagePrefsAction, type PrefState } from "./message-actions";

export type KindOption = { key: string; label: string; blurb: string };

/**
 * What this client is sent at all.
 *
 * The other card answers *which of their groups* a message goes to. This one
 * answers whether it is sent — which is the question a client actually raises.
 * Nobody says "you sent that to the wrong chat"; they say "you send me too
 * much".
 *
 * Deliberately separate from the group card rather than merged into it. They
 * are two questions about the same message and answering them in one grid
 * produces a row of boxes where the reader cannot tell which is which.
 */
export function MessagePrefs({
  clientId,
  kinds,
  on,
  /**
   * The switches this database can actually store.
   *
   * A column that has not been applied is not a switch — it is a checkbox that
   * springs straight back the next time the page renders, because a missing
   * column reads as "on". Offering it anyway looks exactly like a broken save,
   * and it was reported as one.
   */
  storable,
}: {
  clientId: number;
  kinds: KindOption[];
  on: string[];
  storable: string[];
}) {
  const [state, action] = useActionState<PrefState, FormData>(saveMessagePrefsAction, {});
  const notReady = kinds.filter((k) => !storable.includes(k.key));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          What they hear from us
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Unticked means we stop sending it — not that it goes somewhere else. The work still
          happens either way; only the message stops.
        </p>
      </CardHeader>

      <CardContent>
        <form action={action} className="space-y-3">
          <input type="hidden" name="client_id" value={clientId} />

          {notReady.length ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                <b>{notReady.map((k) => k.label).join(", ")}</b>{" "}
                {notReady.length === 1 ? "cannot be saved yet" : "cannot be saved yet"} — the
                database has not had those columns applied, so unticking them will not stick.
                Run <b>Settings → Database → Apply</b>, then come back.
              </span>
            </p>
          ) : null}

          <div className="space-y-1.5">
            {kinds.map((k) => (
              <label
                key={k.key}
                htmlFor={`msg-${k.key}`}
                className={`flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors ${
                  storable.includes(k.key) ? "cursor-pointer hover:bg-muted/60" : "opacity-60"
                }`}
              >
                <input
                  id={`msg-${k.key}`}
                  type="checkbox"
                  name={`m_${k.key}`}
                  value="1"
                  defaultChecked={on.includes(k.key)}
                  disabled={!storable.includes(k.key)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
                />
                <span className="text-xs leading-snug">
                  <span className="font-medium">{k.label}</span>
                  {storable.includes(k.key) ? null : (
                    <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      not applied
                    </span>
                  )}
                  <br />
                  <span className="text-muted-foreground">{k.blurb}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <SubmitButton variant="secondary" size="sm">
              Save
            </SubmitButton>
            {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
            {state.ok ? (
              <span className="flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" /> {state.message}
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
