import Link from "next/link";
import {
  Megaphone,
  Wallet,
  Eye,
  Target,
  MousePointerClick,
  TriangleAlert,
  RefreshCw,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import { adSummary, adsReadiness, lastAdSync } from "@/lib/ads";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { RangePicker } from "./range-picker";
import { resolveRange } from "@/lib/date-range";
import { SyncButton } from "./sync-button";
import { ClientPicker } from "./client-picker";
import { fmtDate } from "@/lib/utils";
import { prettyLocal } from "@/lib/posting";

export const metadata = { title: "Ad management · NVK Hub" };
export const dynamic = "force-dynamic";

/** Money, in whatever currency the ad account reports. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    // An unknown currency code should not take the page down over formatting.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);

/**
 * What the ads cost and what they returned.
 *
 * Every figure here comes from Meta's own insights for the client's ad
 * account — nothing on this page was typed by anybody. That is the point of
 * it: spend and cost per lead are the numbers a client argues about, and a
 * number someone keyed in at month end cannot be defended.
 *
 * Three things are deliberately not shown as zero. A client with no ad account
 * is listed as not connected rather than given a ₹0 row; a client connected
 * but quiet in this range is listed separately; and cost per lead with no
 * leads is a dash, because dividing by nothing is not free acquisition.
 */
export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;

  const readiness = await adsReadiness();
  if (!readiness.ready) {
    return (
      <div className="space-y-5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Megaphone className="h-6 w-6 text-primary" /> Ad management
        </h1>
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <TriangleAlert className="mx-auto h-8 w-8 text-warning" />
            <p className="text-sm text-muted-foreground">{readiness.reason}</p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Go to Settings → Database
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { from, to, key } = resolveRange(sp.range, sp.from, sp.to);
  // Every client the viewer may see, not only the ones that spent in this
  // range — a client who paused last month is exactly who gets looked up.
  const [data, syncedAt, clients] = await Promise.all([
    adSummary(from, to),
    lastAdSync(),
    getClientsMini(await crmClientIds(user)),
  ]);
  const t = data.totals;

  // One currency is the normal case and reads best; two means the totals row
  // has to break down rather than pretend to a single figure.
  const one = t.spendByCurrency.length === 1 ? t.spendByCurrency[0] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Megaphone className="h-6 w-6 text-primary" /> Ad management
          </h1>
          <p className="text-sm text-muted-foreground">
            {fmtDate(from)} – {fmtDate(to)} · straight from Meta
            {syncedAt ? `, last refreshed ${prettyLocal(syncedAt) ?? "—"}` : ", never refreshed yet"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ClientPicker clients={clients} range={key} />
          <RangePicker current={key} />
          <SyncButton />
        </div>
      </div>

      {/* The four the board exists for, in the order they get asked about. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Spent"
          value={one ? money(one.spend, one.currency) : t.spendByCurrency.length ? "Mixed" : "—"}
          icon={Wallet}
          tone="violet"
          hint={
            one
              ? undefined
              : t.spendByCurrency.map((s) => money(s.spend, s.currency)).join(" · ") || undefined
          }
        />
        <StatCard title="Impressions" value={num(t.impressions)} icon={Eye} tone="sky" />
        <StatCard title="Leads" value={num(t.leads)} icon={Target} tone="emerald" />
        <StatCard
          title="Cost per lead"
          value={
            t.costPerLead !== null && t.currency ? money(t.costPerLead, t.currency) : "—"
          }
          icon={MousePointerClick}
          tone="amber"
          hint={
            t.leads === 0
              ? "No leads in this range"
              : t.currency === null
                ? "Several currencies — see each client"
                : undefined
          }
        />
      </div>

      {data.rows.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">By client</CardTitle>
            <p className="text-xs text-muted-foreground">
              Biggest spender first. Cost per lead is spend ÷ leads for that client alone —
              never an average of averages.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table dense>
              <THead>
                <tr>
                  <th>Client</th>
                  <th className="text-right">Spent</th>
                  <th className="text-right">Impressions</th>
                  <th className="text-right">Reach</th>
                  <th className="text-right">Clicks</th>
                  <th className="text-right">CTR</th>
                  <th className="text-right">Leads</th>
                  <th className="text-right">Cost / lead</th>
                  <th className="text-right">CPM</th>
                </tr>
              </THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={`${r.clientId}-${r.currency}`}>
                    <TD className="max-w-[12rem]">
                      {/* Through to this client's own account rather than
                          their general record: someone clicking a cost per
                          lead wants the days behind it, and the contact to
                          ring about them, which is what that page carries. */}
                      <Link
                        href={`/ads/${r.clientId}?range=${key}`}
                        className="font-medium transition-colors hover:text-primary hover:underline"
                      >
                        {r.company}
                      </Link>
                      {r.lastSynced ? (
                        <div className="text-xs text-muted-foreground">
                          to {fmtDate(r.lastSynced)}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="text-right font-medium tabular-nums">
                      {money(r.spend, r.currency)}
                    </TD>
                    <TD className="text-right tabular-nums">{num(r.impressions)}</TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {num(r.reach)}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {num(r.clicks)}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {r.ctr === null ? "—" : `${r.ctr.toFixed(2)}%`}
                    </TD>
                    <TD className="text-right font-medium tabular-nums">{num(r.leads)}</TD>
                    {/* The number this board is opened for. A dash rather than
                        a zero: no leads is not a cheap lead. */}
                    <TD className="text-right font-medium tabular-nums">
                      {r.costPerLead === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        money(r.costPerLead, r.currency)
                      )}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {r.cpm === null ? "—" : money(r.cpm, r.currency)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-2 p-10 text-center">
            <RefreshCw className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No ad data for {fmtDate(from)} – {fmtDate(to)}.
              {syncedAt
                ? " Either nothing ran in this period, or it has not been refreshed since."
                : " Press Refresh from Meta to pull it in."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Absence, explained. A client missing from the table above is either
          quiet or unconnected, and those need different actions. */}
      {data.connectedButQuiet.length > 0 || data.notConnected.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not in the numbers above</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {data.connectedButQuiet.length > 0 ? (
              <p>
                <span className="font-medium">No spend in this range:</span>{" "}
                <span className="text-muted-foreground">
                  {data.connectedButQuiet.join(", ")}
                </span>
              </p>
            ) : null}
            {data.notConnected.length > 0 ? (
              <p>
                <span className="font-medium">No ad account connected:</span>{" "}
                <span className="text-muted-foreground">{data.notConnected.join(", ")}</span>
                <br />
                <span className="text-xs text-muted-foreground">
                  Add their Meta ad account id on the client&apos;s edit page and they appear
                  here after the next refresh.
                </span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
