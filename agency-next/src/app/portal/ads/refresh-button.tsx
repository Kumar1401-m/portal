"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/**
 * Fetch the figures again.
 *
 * Deliberately not a pull from Meta. The admin board has that button and it
 * belongs there: reading an ad account spends the agency's API allowance, and
 * a client with a refresh button wired to Meta could burn a day of it in a
 * minute without ever knowing they had. This re-reads what the portal already
 * holds, which is what a person means when they press refresh on their own
 * results page.
 *
 * So the honest thing is to say when the figures are from, which the line
 * beside this button does. If that date is old, the answer is a sync on the
 * agency's side, not a harder press here.
 */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className={buttonClasses({ variant: "secondary", size: "sm" })}
      title="Fetch the latest figures we hold"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
