"use client";

import { Printer } from "lucide-react";

/**
 * The browser's own print dialog, which is also its PDF writer.
 *
 * No PDF library and no headless Chrome on the server: every browser this
 * agency uses — desktop and both phone platforms — offers "Save as PDF" from
 * this dialog, and it renders the page's real fonts, so a Telugu client name
 * comes out as a Telugu client name. A server-side renderer would have to be
 * fed the same fonts to match, at the cost of a fifty-megabyte dependency.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-md bg-[#ea580c] px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#c2410c] print:hidden"
    >
      <Printer className="h-4 w-4" />
      Save as PDF
    </button>
  );
}
