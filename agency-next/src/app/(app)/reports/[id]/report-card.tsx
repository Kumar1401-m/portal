"use client";

import { useState, useTransition } from "react";
import { Send, Loader2, FileText, FileDown, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { sendMonthlyReportAction } from "./actions";

/**
 * The month, written up, exactly as the client will receive it.
 *
 * Shown rather than described. This is a message that goes to a client's
 * WhatsApp group, and the only version of "are you sure" worth having is the
 * text itself — a confirmation dialog asking about a message nobody has read
 * is a dialog everybody clicks through.
 *
 * Collapsed by default: the report page is opened to look at the task list far
 * more often than to send anything.
 */
export function MonthlyReportCard({
  clientId,
  month,
  monthLabel,
  text,
}: {
  clientId: number;
  month: string;
  monthLabel: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <FileText className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Monthly report — {monthLabel}</span>
          <span className="block text-xs text-muted-foreground">
            Built from what was delivered, how it performed, and what the ads cost.
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border p-4">
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-sans text-sm leading-relaxed">
            {text}
          </pre>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Goes to this client&apos;s linked WhatsApp group. Sections with nothing in them are
              left out rather than sent as zero.
            </p>
            {/* The same month as a document. Its own tab, because the next
                thing that happens there is a print dialog. */}
            <a
              href={`/report/${clientId}?month=${month}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonClasses({ variant: "outline", size: "sm" })} ml-auto`}
            >
              <FileDown className="h-4 w-4" /> PDF
            </a>
            <button
              type="button"
              disabled={pending || sent}
              onClick={() =>
                start(async () => {
                  const res = await sendMonthlyReportAction(clientId, month);
                  if (res.ok) setSent(true);
                  toast({
                    title: res.ok ? "Report sent" : "Not sent",
                    description: res.message,
                    tone: res.ok ? undefined : "error",
                    ack: !res.ok,
                  });
                })
              }
              className={buttonClasses({ size: "sm" })}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sent ? "Sent" : pending ? "Sending…" : "Send to the client"}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
