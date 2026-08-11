"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/use-hydrated";
import { buttonClasses } from "@/components/ui/button";

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
 * Two strengths, because the actions are not all the same size.
 *
 * A plain toast is centred, sits over the page without blocking it, and fades
 * after a few seconds. Right for a saved edit or a changed target: worth
 * seeing, not worth stopping for.
 *
 * `ack: true` makes it a dialog instead — dimmed backdrop, and it stays until
 * OK is pressed. That is for the moments the work leaves the building, where
 * "did that actually send?" is a question worth one deliberate click to
 * answer, and where pressing the button again costs the client a second copy
 * of the same video.
 *
 * `role="status"` on the toasts, `alertdialog` on the acknowledgement: one is
 * announced after whatever is being read, the other interrupts, which is the
 * difference between the two in a screen reader as much as on screen.
 */

type Tone = "success" | "error";

export type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
  /** Hold the screen until it is acknowledged. */
  ack?: boolean;
};

type Show = (t: {
  title: string;
  description?: string;
  tone?: Tone;
  ack?: boolean;
}) => void;

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
    ({ title, description, tone = "success", ack = false }) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, title, description, tone, ack }]);
      // Errors and acknowledgements stay until dismissed. A failure that
      // vanishes on its own is a failure nobody acts on.
      if (tone !== "error" && !ack) setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss]
  );

  // Newest wins if two land at once — the one being answered is the one that
  // just happened.
  const acked = toasts.filter((t) => t.ack);
  const dialog = acked[acked.length - 1];

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
        {toasts
          .filter((t) => !t.ack)
          .map((t) => (
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

      {dialog ? <AckDialog toast={dialog} onClose={() => dismiss(dialog.id)} /> : null}
    </ToastContext.Provider>
  );
}

/**
 * The stop-and-read version.
 *
 * Portalled to <body> for the same reason the other modals are: it is opened
 * from inside cards and tables, and a `position: fixed` overlay anchors to the
 * nearest transformed ancestor rather than the viewport, which then clips it.
 *
 * Above the Modal layer (z-50), because the thing being confirmed is very
 * often a modal that has just closed — or is about to.
 */
function AckDialog({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const mounted = useHydrated();
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    // The keyboard lands on the only thing there is to do, so Enter closes it.
    okRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  if (!mounted) return null;
  const good = toast.tone === "success";

  return createPortal(
    <div className="fixed inset-0 z-[110] grid place-items-center p-4">
      {/* Clicking away dismisses it. There is nothing to lose here — the thing
          it describes has already happened. */}
      <div className="animate-fade-in absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ack-title"
        aria-describedby={toast.description ? "ack-body" : undefined}
        className="animate-pop-in relative z-10 w-[min(24rem,100%)] rounded-xl bg-card p-7 text-center shadow-2xl"
      >
        <span
          className={cn(
            "mx-auto grid h-14 w-14 place-items-center rounded-full",
            good
              ? "bg-[color-mix(in_srgb,var(--success)_16%,transparent)]"
              : "bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)]"
          )}
        >
          {good ? (
            <Check className="h-7 w-7 text-success" />
          ) : (
            <TriangleAlert className="h-7 w-7 text-destructive" />
          )}
        </span>
        <h2 id="ack-title" className="mt-4 text-xl font-semibold tracking-tight">
          {toast.title}
        </h2>
        {toast.description ? (
          <p id="ack-body" className="mt-2 text-sm text-muted-foreground">
            {toast.description}
          </p>
        ) : null}
        <button
          ref={okRef}
          type="button"
          onClick={onClose}
          className={cn(buttonClasses({ size: "lg" }), "mt-6 w-full justify-center")}
        >
          OK
        </button>
      </div>
    </div>,
    document.body
  );
}
