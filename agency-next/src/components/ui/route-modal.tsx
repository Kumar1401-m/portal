"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

/**
 * A modal driven by the URL rather than local state — the panel an intercepted
 * route renders into.
 *
 * Closing means going back, so the address bar and the popup never disagree:
 * the same /deliverables/42 link opens as a popup over whatever you were
 * looking at, and still renders as a full page if you paste it fresh or hit
 * reload.
 *
 * Portalled to <body> for the same reason as the plain Modal: a `position:
 * fixed` overlay is anchored to the nearest transformed ancestor (an
 * animation's fill counts), and then clipped by that ancestor's overflow.
 */
export function RouteModal({
  children,
  size = "wide",
}: {
  children: React.ReactNode;
  size?: "wide" | "normal";
}) {
  const router = useRouter();
  // document.body only exists once mounted on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [router]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6">
      <div
        className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => router.back()}
      />
      <div
        className={`animate-pop-in relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl ${
          size === "wide" ? "max-w-5xl" : "max-w-2xl"
        }`}
      >
        <button
          onClick={() => router.back()}
          aria-label="Close"
          className="absolute right-3 top-3 z-20 rounded-md bg-card/80 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
        {/* min-h-0 lets this flex child shrink so it actually scrolls; without
            it the panel's overflow-hidden clips long content. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">{children}</div>
      </div>
    </div>,
    document.body
  );
}
