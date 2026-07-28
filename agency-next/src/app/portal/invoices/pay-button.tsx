"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, IndianRupee } from "lucide-react";
import { startInvoicePayment, verifyInvoicePayment } from "../actions";
import { Button } from "@/components/ui/button";

/** Minimal shape of the window.Razorpay checkout widget. */
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let scriptLoading: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  if (scriptLoading) return scriptLoading;
  scriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment widget. Check your connection."));
    document.body.appendChild(script);
  });
  return scriptLoading;
}

export function PayButton({
  invoiceId,
  invoiceNo,
  companyName,
  contactEmail,
}: {
  invoiceId: number;
  invoiceNo: string;
  companyName: string;
  contactEmail?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const order = await startInvoicePayment(invoiceId);
      if (!order.ok || !order.order_id || !order.key_id) {
        setError(order.error || "Could not start payment.");
        setBusy(false);
        return;
      }

      await loadRazorpayScript();
      if (!window.Razorpay) throw new Error("Payment widget did not load.");

      const rz = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: companyName,
        description: `Invoice ${invoiceNo}`,
        order_id: order.order_id,
        prefill: contactEmail ? { email: contactEmail } : undefined,
        theme: { color: "#4f46e5" },
        modal: { ondismiss: () => setBusy(false) },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          const result = await verifyInvoicePayment(
            response.razorpay_order_id,
            response.razorpay_payment_id,
            response.razorpay_signature
          );
          setBusy(false);
          if (result.ok) {
            router.refresh();
          } else {
            setError(result.error || "Payment could not be verified — contact the agency.");
          }
        },
      });
      rz.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed to start.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={pay} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <IndianRupee className="h-4 w-4" />}
        Pay now
      </Button>
      {error ? <p className="max-w-48 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
