"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Loader2 } from "lucide-react";
import { Select } from "@/components/ui/select";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { syncInsightsAction } from "./actions";

/**
 * Whose numbers, and how fresh.
 *
 * The client choice stays in the query string rather than becoming a route of
 * its own: everything on this board is the same board narrowed, and the range
 * has to survive the change — switching client and silently landing back on
 * this month would be the page answering a different question from the one
 * that was asked.
 */
export function ClientFilter({
  clients,
  current,
  range,
}: {
  clients: { id: number; company_name: string }[];
  current: number | null;
  range: string;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label="Client"
      value={current ? String(current) : ""}
      onChange={(e) => {
        const v = e.target.value;
        router.push(
          v ? `/analytics?client=${v}&range=${range}` : `/analytics?range=${range}`,
          { scroll: false }
        );
      }}
      className="h-9 w-44 text-sm"
    >
      <option value="">All clients</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company_name}
        </option>
      ))}
    </Select>
  );
}

export function SyncInsights({ clientId }: { clientId?: number | null }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await syncInsightsAction(clientId ?? undefined);
          toast({
            title: res.ok ? "Updated from Instagram" : "Instagram wouldn't answer",
            description: res.message,
            tone: res.ok ? undefined : "error",
            // A token problem is a to-do, not a notification — it stays up
            // until it is read.
            ack: !res.ok,
          });
        })
      }
      className={buttonClasses({ variant: "outline", size: "sm" })}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {pending ? "Reading…" : "Refresh"}
    </button>
  );
}
