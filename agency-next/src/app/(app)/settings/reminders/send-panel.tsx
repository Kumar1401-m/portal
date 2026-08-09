"use client";

import { useActionState, useState, useTransition } from "react";
import {
  Check,
  Clock,
  Loader2,
  Send,
  TriangleAlert,
  RefreshCw,
} from "lucide-react";
import {
  previewReminder,
  sendReminderAction,
  type PreviewState,
  type SendState,
} from "./actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/ui/date-field";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Kind = { kind: string; label: string; blurb: string; perClient: boolean };
type Client = { id: number; company_name: string; hasGroup: boolean };

/** Half-hour slots through the working day. Nobody schedules 3:07pm. */
const SLOTS = Array.from({ length: 34 }, (_, i) => {
  const mins = 6 * 60 + i * 30; // 06:00 → 22:30
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { value, label: `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}` };
});

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Sending a reminder by hand.
 *
 * The order on screen is the order of the decision: what to say, who to say it
 * to, then read it, then when. The message is shown before the send button
 * exists, because these go to real client groups and the one safeguard worth
 * having is that somebody read it.
 *
 * The text is editable. It is composed from live data, which is right nine
 * times out of ten and wrong the tenth — and on the tenth the choice should be
 * "fix this line" rather than "give up and open WhatsApp".
 */
export function SendPanel({
  kinds,
  clients,
  teamGroupSet,
}: {
  kinds: Kind[];
  clients: Client[];
  /** Whether WHATSAPP_TEAM_GROUP_ID is configured — the team digest needs it. */
  teamGroupSet: boolean;
}) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? "footage_due");
  const [clientId, setClientId] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<PreviewState>({});
  const [loading, startPreview] = useTransition();
  const [when, setWhen] = useState<"now" | "later">("now");
  const [state, action, sending] = useActionState<SendState, FormData>(sendReminderAction, {});

  const spec = kinds.find((k) => k.kind === kind);
  const isCustom = kind === "custom";
  const needsClient = Boolean(spec?.perClient);
  const client = clients.find((c) => String(c.id) === clientId);

  /*
   * Recompose whenever the target changes.
   *
   * One rule, applied the same way every time: change the reminder or change
   * the client and the message is rewritten. Anything cleverer — keeping edits
   * across a change of client, say — ends with one client reading a message
   * composed for another, which is the single worst thing this page could do.
   *
   * Driven from the handlers rather than an effect. Choosing a client is a
   * user action with a result, not two pieces of state that need keeping in
   * step, and writing it as a synchronisation would cost a wasted render of
   * the previous client's message.
   */
  const load = (nextKind: string, nextClientId: string) => {
    const target = kinds.find((k) => k.kind === nextKind);
    if (nextKind === "custom") {
      setPreview({});
      setBody("");
      return;
    }
    if (target?.perClient && !nextClientId) {
      setPreview({});
      setBody("");
      return;
    }
    startPreview(async () => {
      const res = await previewReminder(nextKind, nextClientId ? Number(nextClientId) : null);
      setPreview(res);
      setBody(res.text || "");
    });
  };

  const chooseKind = (next: string) => {
    setKind(next);
    load(next, clientId);
  };

  const chooseClient = (next: string) => {
    setClientId(next);
    load(kind, next);
  };

  const blocked =
    (needsClient && !clientId) ||
    (needsClient && client && !client.hasGroup) ||
    (!needsClient && !teamGroupSet) ||
    Boolean(preview.noGroup);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-5 w-5 text-primary" /> Send a reminder
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Goes to the client&apos;s own WhatsApp group — the same one they approve videos in.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* 1. What to say. */}
        <div className="space-y-2">
          <Label>Reminder</Label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {kinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => chooseKind(k.kind)}
                aria-pressed={k.kind === kind}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  k.kind === kind
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border hover:bg-accent/40"
                )}
              >
                <span className="block text-sm font-medium">{k.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{k.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 2. Who to. */}
        {needsClient ? (
          <div className="space-y-1.5">
            <Label htmlFor="reminder-client">Client</Label>
            <Select
              id="reminder-client"
              value={clientId}
              onChange={(e) => chooseClient(e.target.value)}
              className="max-w-md"
            >
              <option value="">Choose a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.hasGroup}>
                  {c.company_name}
                  {c.hasGroup ? "" : " — no WhatsApp group"}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {teamGroupSet
              ? "Goes to the agency's own group, not a client's."
              : "No team group is set, so this can't be sent. Add WHATSAPP_TEAM_GROUP_ID to the environment."}
          </p>
        )}

        {/* 3. Read it. */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="reminder-body">
              {isCustom ? "Your message" : "What they'll read"}
            </Label>
            {!isCustom && !blocked ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => load(kind, clientId)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} /> Rebuild from
                today&apos;s data
              </button>
            ) : null}
          </div>

          {loading ? (
            <p className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Working out what to say…
            </p>
          ) : preview.error ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{preview.error}</span>
            </p>
          ) : !isCustom && !body ? (
            <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              {preview.nothing || "Pick a client to see the message."}
            </p>
          ) : (
            <>
              <Textarea
                id="reminder-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={isCustom ? 5 : 10}
                placeholder={isCustom ? "Type the message…" : ""}
                className="font-mono text-xs leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                Edit anything you like. *Text between asterisks* comes out bold in WhatsApp.
              </p>
            </>
          )}

          {preview.warning ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {preview.warning} The message points at the portal instead, which still works.
              </span>
            </p>
          ) : null}
        </div>

        {/* 4. When. */}
        <form action={action} className="space-y-3 border-t border-border pt-4">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="body" value={body} />
          <input type="hidden" name="when" value={when} />

          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["now", "Send now"],
                ["later", "At a set time"],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => setWhen(value)}
                aria-pressed={when === value}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors",
                  when === value
                    ? "border-primary bg-primary/5 font-medium text-primary"
                    : "border-border text-muted-foreground hover:bg-accent/40"
                )}
              >
                {text}
              </button>
            ))}
          </div>

          {when === "later" ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="reminder-date">Date</Label>
                <DateField
                  id="reminder-date"
                  name="sendDate"
                  defaultValue={todayIso()}
                  className="w-48"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reminder-time">Time</Label>
                <Select id="reminder-time" name="sendTime" defaultValue="10:00" className="w-36">
                  {SLOTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="pb-2.5 text-xs text-muted-foreground">
                Indian time. It goes out within a few minutes of the slot.
              </p>
            </div>
          ) : null}

          {state.error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {state.error}
                {state.warning ? <span className="block text-xs">{state.warning}</span> : null}
              </span>
            </p>
          ) : null}

          {state.ok ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              {state.scheduled
                ? `Scheduled for ${state.whenLocal}. It's on the list below until it goes.`
                : "Sent."}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={sending || blocked || !body.trim()}
            className={buttonClasses()}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : when === "later" ? (
              <Clock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {sending
              ? "Working…"
              : when === "later"
                ? "Schedule it"
                : `Send${client ? ` to ${client.company_name}` : " now"}`}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
