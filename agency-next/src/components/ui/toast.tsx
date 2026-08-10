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
      {/*
        Centred, not tucked into a corner.

        A corner toast is the convention for something you may safely ignore.
        These are not that: sending a video to a client is the moment the work
        leaves the building, and the confirmation has to land where the eyes
        already are — which, having just clicked a button in a modal, is the
        middle of the screen.

        `pointer-events-none` on the layer and `auto` on the box: it sits over
        the page without blocking it, so it is prominent without being a
        dialog nobody asked to open.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 p-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex w-[min(26rem,100%)] items-start gap-3 rounded-xl border-2 bg-card p-5 shadow-2xl",
              "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:fade-in",
              t.tone === "success" ? "border-success/50" : "border-destructive/50"
            )}
          >
            <span
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-full",
                t.tone === "success"
                  ? "bg-[color-mix(in_srgb,var(--success)_16%,transparent)]"
                  : "bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)]"
              )}
            >
              {t.tone === "success" ? (
                <Check className="h-5 w-5 text-success" />
              ) : (
                <TriangleAlert className="h-5 w-5 text-destructive" />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-base font-semibold">{t.title}</p>
              {t.description ? (
                <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
