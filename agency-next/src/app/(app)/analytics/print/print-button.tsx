"use client";

import { useEffect } from "react";
import { Printer } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/**
 * Opens the browser's print dialog, where "Save as PDF" is the destination.
 *
 * A deliberate choice over a server-side PDF renderer: headless Chrome or a
 * Gotenberg container would add ~300 MB of dependency and a service to keep
 * alive, and would not survive Vercel's serverless limits. The browser already
 * has a production-grade PDF engine, it honours the @media print rules on the
 * page, and the output is selectable text rather than a screenshot.
 *
 * The trade-off is that a *scheduled* report can't attach a PDF this way —
 * which is why the emailed weekly and monthly reports carry their figures
 * inline as HTML instead, and link back here.
 */
export function PrintButton() {
  // Fires once on open, so arriving from the dashboard's "PDF" button lands
  // straight in the dialog. The delay lets the charts finish their first paint;
  // printing mid-render produces blank canvases.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("autoprint")) return;
    const timer = setTimeout(() => window.print(), 700);
    return () => clearTimeout(timer);
  }, []);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={buttonClasses({ variant: "secondary", size: "sm" })}
    >
      <Printer className="h-3.5 w-3.5" /> Save as PDF
    </button>
  );
}
