"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Send, Trash2, Loader2 } from "lucide-react";
import { askAssistant } from "@/app/(app)/assistant-actions";
import { buttonClasses } from "@/components/ui/button";

type Msg = { role: "you" | "ai"; text: string };

/** **bold** and line breaks — the only formatting the answers use. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <span key={i} className="block">
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong key={j} className="font-semibold text-foreground">
                {part.slice(2, -2)}
              </strong>
            ) : (
              <span key={j}>{part}</span>
            )
          )}
        </span>
      ))}
    </>
  );
}

export function AiAssistant({
  name,
  roleLabel,
  suggestions,
}: {
  name: string;
  roleLabel: string;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "you", text: q }]);
    setBusy(true);
    const res = await askAssistant(q);
    setMsgs((m) => [...m, { role: "ai", text: res.text }]);
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
      >
        <Sparkles className="h-5 w-5" />
        AI
      </button>
    );
  }

  return (
    <div className="animate-pop-in fixed bottom-5 right-5 z-40 flex h-[min(34rem,80vh)] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-white">
        <span className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-5 w-5" /> NVK Assistant
        </span>
        <span className="flex items-center gap-1">
          {msgs.length ? (
            <button
              type="button"
              onClick={() => setMsgs([])}
              aria-label="Clear the conversation"
              className="rounded-md p-1 transition-colors hover:bg-white/15"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close the assistant"
            className="rounded-md p-1 transition-colors hover:bg-white/15"
          >
            <X className="h-5 w-5" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="rounded-lg bg-muted p-3 text-sm">
          <p className="font-medium">👋 Hello, {name}!</p>
          <p className="mt-1 text-muted-foreground">
            I can answer questions about your content, approvals and workload — scoped to{" "}
            {roleLabel}. Ask away, or tap one below.
          </p>
        </div>

        {msgs.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "you"
                ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                : "max-w-[92%] rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed"
            }
          >
            {m.role === "ai" ? <Rich text={m.text} /> : m.text}
          </div>
        ))}

        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {!busy ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-border px-3 py-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="flex shrink-0 items-center gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your tasks…"
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className={buttonClasses({ size: "icon" })}
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
