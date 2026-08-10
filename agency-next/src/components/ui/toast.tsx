"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A confirmation that outlives the click.
 *
 * Several actions in the portal reach outside it — a video sent to a client's
 * WhatsApp group, a reminder queued, a post scheduled — and until now they
 * confirmed themselves with a line of text at the bottom of whatever card held
 * the button. In a modal that closes on save, nobody ever saw it. On a long
 * task page, the line appeared below the fold. Both read as "nothing
 * happened", and the honest response to that is to press the button again —
 * which sends the client a second copy of the same video.
 *
 * So: one stack, fixed to the corner, above everything, that stays for a few
 * seconds after the thing that caused it has gone.
 *
 * `role="status"` with `aria-live="polite"` rather than an alert — this is
 * confirmation of something the person just did, so it should be announced
 * after whatever they are reading, not cut across it.
 */

type Tone = "success" | "error";

export type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
};

type Show = (t: { title: string; description?: string; tone?: Tone }) => void;

const ToastContext = createContext<Show | null>(null);

/** How long a toast stays. Long enough to read twice, short enough to ignore. */
const LIFETIME_MS = 6000;

export function useToast(): Show {
  const show = useContext(ToastContext);
  // A no-op rather than a throw: a component rendered outside the provider
  // (a test, a story, an intercepted route) should degrade to silence, not
  // take the page down over a confirmation message.
  return show ?? (() => {});
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<Show>(
    ({ title, description, tone = "success" }) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, title, description, tone }]);
      // Errors stay until dismissed. A failure that vanishes on its own is a
      // failure nobody acts on.
      if (tone !== "error") setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:translate-x-0"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border p-3 shadow-lg backdrop-blur",
              "motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in",
              t.tone === "success"
                ? "border-success/40 bg-card"
                : "border-destructive/40 bg-card"
            )}
          >
            {t.tone === "success" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
