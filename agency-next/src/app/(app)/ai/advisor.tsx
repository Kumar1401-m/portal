"use client";

import { useState, useTransition } from "react";
import { Loader2, Briefcase } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { adviseAction } from "./actions";

type Row = { client: string; fee: number; delivered: number; perTask: number | null };
type Advice = {
  summary: string;
  narrated: boolean;
  clients: Row[];
  atRisk: { client: string; score: number; reasons: string[] }[];
};

const inr = (v: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v);

/**
 * The agency's own month, for whoever owns it.
 *
 * Behind a button because it is several queries and a model call, and it is
 * read once a month rather than every time somebody opens the AI page.
 */
export function BusinessAdvisor() {
  const [data, setData] = useState<Advice | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 font-medium">
              <Briefcase className="h-4 w-4 text-muted-foreground" /> Business advisor
            </p>
            <p className="text-xs text-muted-foreground">
              Which clients earn, which cost, and who is about to leave.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await adviseAction();
                if (res.ok) setData(res.data as Advice);
                else toast({ title: "Not available", description: res.error, tone: "error", ack: true });
              })
            }
            className={buttonClasses({ variant: "outline", size: "sm" })}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {data ? "Look again" : "Read this month"}
          </button>
        </div>

        {data ? (
          <>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.summary}</p>

            {data.clients.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Fee per delivered task
                </p>
                <div className="space-y-1">
                  {data.clients.slice(0, 8).map((c) => (
                    <div key={c.client} className="flex justify-between gap-3 text-sm">
                      <span className="truncate">{c.client}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {c.perTask === null ? "—" : inr(c.perTask)} · {c.delivered} delivered
                      </span>
                    </div>
                  ))}
                </div>
                {/* The caveat travels with the number, every time. */}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The portal records no hours, so this is fee divided by published work — a proxy
                  for effort, not a profit margin.
                </p>
              </div>
            ) : null}

            {data.atRisk.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  At risk of leaving
                </p>
                {data.atRisk.map((r) => (
                  <p key={r.client} className="text-sm">
                    <span className="font-medium">{r.client}</span>{" "}
                    <span className="tabular-nums text-muted-foreground">{r.score}</span>
                    <span className="block text-xs text-muted-foreground">{r.reasons.join(" · ")}</span>
                  </p>
                ))}
              </div>
            ) : null}

            {!data.narrated ? (
              <p className="text-xs text-muted-foreground">
                Straight from the portal&apos;s own figures. No model answered.
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
