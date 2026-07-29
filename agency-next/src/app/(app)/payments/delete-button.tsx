"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { deletePayment, deleteInvoice } from "./actions";
import { buttonClasses } from "@/components/ui/button";

/**
 * Deletes a payment or an invoice from the history. Super admin only — the
 * page decides whether to render it at all, and the action re-checks.
 *
 * Confirmed twice over: this is financial history and the reported revenue
 * moves with it, so the prompt spells out what disappears.
 */
export function DeleteRecordButton({
  kind,
  id,
  label,
  amount,
}: {
  kind: "payment" | "invoice";
  id: number;
  /** How the record reads in the confirmation, e.g. "INV-2026-0007". */
  label: string;
  amount: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const warn =
    kind === "invoice"
      ? `Delete invoice ${label} for ${amount}?\n\nThis also removes every payment recorded against it, and this month's revenue will drop by that amount. There is no undo.`
      : `Delete the ${amount} payment for ${label}?\n\nRevenue drops by that amount, and if this was what settled the invoice it goes back to unpaid. There is no undo.`;

  return (
    <>
      <button
        type="button"
        disabled={pending}
        title={kind === "invoice" ? "Delete this invoice" : "Delete this payment"}
        aria-label={`Delete ${label}`}
        onClick={() => {
          if (!confirm(warn)) return;
          setError(null);
          start(async () => {
            const res = kind === "invoice" ? await deleteInvoice(id) : await deletePayment(id);
            if (!res.ok) setError(res.error ?? "Could not delete that.");
          });
        }}
        className={buttonClasses({ variant: "ghost", size: "icon" })}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4 text-destructive" />
        )}
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </>
  );
}
