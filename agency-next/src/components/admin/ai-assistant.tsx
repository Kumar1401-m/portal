"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Send, Trash2, Loader2 } from "lucide-react";
import { askAssistant } from "@/app/(app)/assistant-actions";
import { buttonClasses } from "@/components/ui/button";

type Msg = { role: "you" | "ai"; text: string };
type Pos = { x: number; y: number };

const POS_KEY = "nvk-assistant-pos";

/** Keep the widget on screen — after a resize, or a window it no longer fits. */
const clamp = (p: Pos, w: number, h: number): Pos => ({
  x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8)),
  y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - h - 8)),
});

/**
 * Drag-to-move, shared by the bubble and the open panel's header.
 *
 * A drag and a click start identically, so movement is measured: anything
 * under a few pixels stays a click (opening the chat), beyond that the click
 * is swallowed so dragging never opens the panel by accident.
 */
function useDraggable(ref: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<Pos | null>(null);
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(
    null
  );
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) setPos(JSON.parse(raw) as Pos);
    } catch {
      /* first run, or storage unavailable — fall back to the default corner */
    }
  }, []);

  // A saved spot can fall off screen when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const el = ref.current;
      if (!el || !pos) return;
      setPos((p) => (p ? clamp(p, el.offsetWidth, el.offsetHeight) : p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos, ref]);

  function onPointerDown(e: React.PointerEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      const node = ref.current;
      if (!d || !node) return;
      // Past this many pixels it's a drag, not a click on the bubble.
      if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) > 4) d.moved = true;
      setPos(
        clamp({ x: ev.clientX - d.dx, y: ev.clientY - d.dy }, node.offsetWidth, node.offsetHeight)
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      setPos((p) => {
        if (p) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(p));
          } catch {
            /* storage full or blocked — position just won't persist */
          }
        }
        return p;
      });
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : { right: 20, bottom: 20 };

  return { style, onPointerDown, dragging, didDrag: () => Boolean(drag.current?.moved) };
}

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
  const boxRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const panelDrag = useDraggable(boxRef);
  const bubbleDrag = useDraggable(bubbleRef);

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
      <div
        ref={bubbleRef}
        style={bubbleDrag.style}
        onPointerDown={bubbleDrag.onPointerDown}
        className={`fixed z-40 touch-none select-none ${bubbleDrag.dragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <button
          type="button"
          onClick={() => {
            // Swallow the click that ends a drag, so moving it doesn't open it.
            if (bubbleDrag.didDrag()) return;
            setOpen(true);
          }}
          aria-label="Open the assistant — drag to move"
          title="Drag me anywhere"
          className="flex items-center gap-2 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
        >
          <Sparkles className="h-5 w-5" />
          AI
        </button>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      style={panelDrag.style}
      className="animate-pop-in fixed z-40 flex h-[min(34rem,80vh)] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
    >
      <div
        onPointerDown={panelDrag.onPointerDown}
        className={`flex shrink-0 touch-none select-none items-center justify-between bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-white ${
          panelDrag.dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        title="Drag to move"
      >
        <span className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-5 w-5" /> NVK Assistant
        </span>
        <span className="flex items-center gap-1">
          {msgs.length ? (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMsgs([])}
              aria-label="Clear the conversation"
              className="rounded-md p-1 transition-colors hover:bg-white/15"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
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
