import Link from "next/link";
import {
  FileText,
  PenTool,
  CheckCircle2,
  Hourglass,
  PencilLine,
  CircleDashed,
} from "lucide-react";
import type { ProductionRow } from "@/lib/queries";
import { Card } from "@/components/ui/card";

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide first:text-left">
      {children}
    </th>
  );
}

export function ProductionSummary({ rows }: { rows: ProductionRow[] }) {
  const totals = rows.reduce(
    (a, r) => ({
      required: a.required + r.required,
      designed: a.designed + r.designed,
      approved: a.approved + r.approved,
      awaiting: a.awaiting + r.awaiting,
      changes: a.changes + r.changes,
      pending: a.pending + r.pending,
    }),
    { required: 0, designed: 0, approved: 0, awaiting: 0, changes: 0, pending: 0 }
  );

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-semibold tracking-tight">This month&apos;s production summary</h2>
        <p className="text-sm text-muted-foreground">Per-client content pipeline for the current month.</p>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gradient-to-r from-indigo-700 to-violet-700 text-white">
              <Th>#</Th>
              <Th>Client</Th>
              <Th>
                <span className="inline-flex items-center gap-1"><FileText className="h-3.5 w-3.5" /> Required</span>
              </Th>
              <Th>
                <span className="inline-flex items-center gap-1"><PenTool className="h-3.5 w-3.5" /> Designed</span>
              </Th>
              <Th>
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Approved</span>
              </Th>
              <Th>
                <span className="inline-flex items-center gap-1"><Hourglass className="h-3.5 w-3.5" /> Pending approval</span>
              </Th>
              <Th>
                <span className="inline-flex items-center gap-1"><PencilLine className="h-3.5 w-3.5" /> Changes</span>
              </Th>
              <Th>
                <span className="inline-flex items-center gap-1"><CircleDashed className="h-3.5 w-3.5" /> Pending</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No active clients.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={r.id} className="border-b border-border odd:bg-muted/30 hover:bg-muted/60">
                  <td className="px-3 py-2.5 text-center text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <Link href={`/clients/${r.id}`} className="font-medium hover:text-primary hover:underline">
                      {r.company_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{r.required || "—"}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{r.designed}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                    {r.approved}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-amber-600 dark:text-amber-400">
                    {r.awaiting}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-rose-600 dark:text-rose-400">
                    {r.changes}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-muted-foreground">{r.pending}</td>
                </tr>
              ))
            )}
          </tbody>
          {rows.length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/50 font-semibold">
                <td className="px-3 py-3" />
                <td className="px-3 py-3">Totals</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.required}</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.designed}</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.approved}</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.awaiting}</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.changes}</td>
                <td className="px-3 py-3 text-center tabular-nums">{totals.pending}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </Card>
  );
}
