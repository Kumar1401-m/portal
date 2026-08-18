"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles, Loader2, RefreshCw, Send, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { refreshInsightsAction, askBrainAction, setEngineAction } from "./actions";
import type { EngineKey } from "@/lib/ai-engines";

export function RefreshInsights() {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await refreshInsightsAction();
          toast({
            title: res.ok ? "Insights refreshed" : "Couldn't refresh",
            description: res.message,
            tone: res.ok ? undefined : "error",
            ack: !res.ok,
          });
        })
      }
      className={buttonClasses({ variant: "outline", size: "sm" })}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {pending ? "Looking…" : "Re-run analysis"}
    </button>
  );
}

/**
 * Ask the Brain about one client.
 *
 * A client has to be picked before a question can be asked, because every
 * answer it gives is about one account's two months — a question with no
 * client attached would be answered about nobody in particular, which is
 * exactly the generic chatbot this is meant not to be.
 */
export function AskBrain({ clients }: { clients: { id: number; company_name: string }[] }) {
  const [clientId, setClientId] = useState<string>(clients[0] ? String(clients[0].id) : "");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; narrated?: boolean } | null>(null);
  const [pending, start] = useTransition();

  const suggestions = [
    "Why did growth slow down this month?",
    "What should we change next month?",
    "How did this month compare to last?",
  ];

  const run = (q: string) => {
    if (!clientId || !q.trim()) return;
    setQuestion(q);
    start(async () => {
      const res = await askBrainAction(Number(clientId), q);
      setAnswer({ text: res.text, narrated: res.narrated });
    });
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <Sparkles className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <h2 className="font-medium">Ask the Brain</h2>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="h-9 w-48 text-sm"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company_name}
              </option>
            ))}
          </Select>
          <div className="flex min-w-56 flex-1 gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") run(question);
              }}
              placeholder="Why did growth slow down this month?"
              className="h-9 text-sm"
            />
            <button
              type="button"
              disabled={pending || !clientId}
              onClick={() => run(question)}
              className={buttonClasses({ size: "sm" })}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={pending}
              onClick={() => run(s)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>

        {answer ? (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.text}</p>
            {/* Said plainly, because it changes how much weight the sentence
                carries: computed figures either way, but only a narrated
                answer had a model choose the words. */}
            <p className="mt-2 text-xs text-muted-foreground">
              {answer.narrated
                ? "Written from figures computed in the portal — the model never sees the database."
                : "Straight from the portal's own figures. No model answered."}
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export type EngineRow = {
  key: EngineKey;
  label: string;
  purpose: string;
  module: string;
  state: string;
  stateText: string;
  on: boolean;
  built: boolean;
};

/**
 * The engine list, with a switch on each.
 *
 * Collapsed, because it is a settings surface sitting on a working screen —
 * open it when something is misbehaving, not every morning.
 */
export function EngineList({ engines, canToggle }: { engines: EngineRow[]; canToggle: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  const live = engines.filter((e) => e.state === "live").length;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">AI engines</span>
          <span className="block text-xs text-muted-foreground">
            {live} of {engines.length} running — each can be switched off on its own
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {engines.map((e) => (
            <div key={e.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <div className="min-w-48 flex-1">
                <p className="text-sm font-medium">{e.label}</p>
                <p className="text-xs text-muted-foreground">{e.purpose}</p>
                {e.module !== "—" ? (
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{e.module}</p>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  e.state === "live"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : e.state === "planned"
                      ? "bg-muted text-muted-foreground"
                      : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                }`}
              >
                {e.stateText}
              </span>
              {canToggle && e.built ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await setEngineAction(e.key, !e.on);
                      toast({ title: `${e.label}: ${res.message}` });
                    })
                  }
                  className={buttonClasses({ variant: "ghost", size: "sm" })}
                >
                  {e.on ? "Switch off" : "Switch on"}
                </button>
              ) : null}
            </div>
          ))}
          <p className="px-4 py-3 text-xs text-muted-foreground">
            A planned engine is specified and not yet built — it is listed so nobody demonstrates a
            feature that is not there. See{" "}
            <Link href="/automations" className="text-primary hover:underline">
              Automations
            </Link>{" "}
            for the jobs that feed them.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
