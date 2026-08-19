"use client";

import { useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { sendInvoicePdf } from "./actions";

/**
 * Send this invoice into the client's group, as a file.
 *
 * No confirmation dialog: the invoice is one click away in the same row, so
 * anybody unsure what is about to be sent can read it first — which is a
 * better check than a dialog asking about a document nobody has opened.
 *
 * It stays disabled once it has gone. Sending the same invoice twice in a
 * minute is the mistake this button makes easy, and the toast is the only
 * other thing saying it worked.
 */
export function SendInvoiceButton({ invoiceId }: { invoiceId: number }) {
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending || sent}
      title="Send this invoice to the client's WhatsApp group as a PDF"
      onClick={() =>
        start(async () => {
          const res = await sendInvoicePdf(invoiceId);
          if (res.ok) setSent(true);
          toast({
            title: res.ok ? "Invoice sent" : "Not sent",
            description: res.message,
            tone: res.ok ? undefined : "error",
            ack: !res.ok,
          });
        })
      }
      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      aria-label="Send the invoice to the client"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
    </button>
  );
}
