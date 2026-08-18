import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Megaphone,
  Wallet,
  Eye,
  Target,
  MousePointerClick,
  Mail,
  Phone,
  User,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient, crmClientIds } from "@/lib/crm";
import { clientAdDetail } from "@/lib/ads";
import { resolveRange } from "@/lib/date-range";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { RangePicker } from "@/components/admin/range-picker";
import { ClientPicker } from "../client-picker";
import { getAudience } from "@/lib/audience";
import { AudienceTile } from "@/components/admin/audience-tile";
import { getClientsMini } from "@/lib/deliverables";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "Client ads · NVK Hub" };
export const dynamic = "force-dynamic";

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const num = (n: number) => new Intl.NumberFormat("en-IN").format(n);

/**
 * One client's ad account, day by day.
 *
 * The board answers "what is this costing us across the book". This answers
 * "what happened on this account", which is the question the moment a client
 * rings about their own numbers — so their contact details are at the top,
 * because whoever opens this page is usually about to talk to them.
 *
 * Same arithmetic as the board, for one client: cost per lead is that day's
 * spend over that day's leads, and a day with no leads shows a dash rather
 * than a zero that would sort to the top of "cheapest".
 */
export default async function ClientAdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  const clientId = Number(id);
  if (!clientId) notFound();

  // A crm sees the clients they were given and no others — the same gate the
  // rest of the portal applies, applied here too rather than assumed.
  if (!(await canAccessClient(user, clientId))) notFound();

  const { from, to, key } = resolveRange(sp.range, sp.from, sp.to);
  // The audience call goes to Meta, so it runs alongside rather than after —
  // and it returns null on any failure, so it can never hold this page up.
  const [detail, audience, clients] = await Promise.all([
    clientAdDetail(clientId, from, to),
    getAudience(clientId),
    getClientsMini(await crmClientIds(user)),
  ]);
  if (!detail) notFound();

  const { client, days, totals, best, worst } = detail;
  const ccy = totals?.currency ?? "INR";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link href="/ads" className={buttonClasses({ variant: "ghost", size: "icon" })}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Megaphone className="h-6 w-6 text-primary" />
              {client.company}
            </h1>
            <p className="text-sm text-muted-foreground">
              {fmtDate(from)} – {fmtDate(to)} · straight from Meta.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ClientPicker clients={clients} current={clientId} range={key} />
          <RangePicker current={key} basePath={`/ads/${clientId}`} />
        </div>
      </div>

      {/*
        The audience the spend is buying.

        Read live from Meta rather than from anything we store, so it is
        whatever the account says right now. A client with neither an
        Instagram account nor a Page configured gets nothing here rather than
        two zeroes, which would read as an audience of none.
      */}
      {audience ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {audience.instagram ? (
            <AudienceTile
              platform="instagram"
              label="Instagram followers"
              handle={audience.instagram.username ? `@${audience.instagram.username}` : null}
              followers={audience.instagram.followers}
              history={audience.instagram.history}
              change={audience.instagram.change}
            />
          ) : null}
          {audience.facebook ? (
            <AudienceTile
              platform="facebook"
              label="Facebook followers"
              handle={audience.facebook.name}
              followers={audience.facebook.followers}
              history={audience.facebook.history}
              change={audience.facebook.change}
            />
          ) : null}
        </div>
      ) : null}

      {/* Who to ring about these numbers. The reason this page exists rather
          than a filter on the board: the figures and the person go together. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
          {client.contactPerson ? (
            <span className="flex items-center gap-1.5">
              <User className="h-4 w-4 text-muted-foreground" />
              {client.contactPerson}
            </span>
          ) : null}
          {client.phone ? (
            <a href={`tel:${client.phone}`} className="flex items-center gap-1.5 hover:text-primary">
              <Phone className="h-4 w-4 text-muted-foreground" />
              {client.phone}
            </a>
          ) : null}
          {client.email ? (
            <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 hover:text-primary">
              <Mail className="h-4 w-4 text-muted-foreground" />
              {client.email}
            </a>
          ) : null}
          {client.monthlyPackage ? (
            <span className="text-muted-foreground">
              {client.monthlyPackage}
              {client.packageAmount > 0 ? ` · ${money(client.packageAmount, "INR")}/mo` : ""}
            </span>
          ) : null}
          <Badge tone={client.status === "active" ? "success" : "muted"}>{client.status}</Badge>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {client.accountId ?? "no ad account connected"}
          </span>
          <Link href={`/clients/${clientId}`} className={buttonClasses({ variant: "ghost", size: "sm" })}>
            Full client record
          </Link>
        </CardContent>
      </Card>

      {!client.accountId ? (
        <Card>
          <CardContent className="space-y-3 p-10 text-center">
            <TriangleAlert className="mx-auto h-8 w-8 text-warning" />
            <p className="text-sm text-muted-foreground">
              No Meta ad account is connected for {client.company}, so there is nothing to
              report. Add their <span className="font-mono text-xs">act_…</span> id and it
              appears here after the next refresh.
            </p>
            <Link
              href={`/clients/${clientId}/edit`}
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              Add their ad account
            </Link>
          </CardContent>
        </Card>
      ) : !totals ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nothing ran on this account between {fmtDate(from)} and {fmtDate(to)}.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Spent" value={money(totals.spend, ccy)} icon={Wallet} tone="violet" />
            <StatCard
              title="Impressions"
              value={num(totals.impressions)}
              icon={Eye}
              tone="sky"
              hint={totals.reach > 0 ? `${num(totals.reach)} people reached` : undefined}
            />
            <StatCard
              title="Leads"
              value={num(totals.leads)}
              icon={Target}
              tone="emerald"
              hint={`over ${totals.activeDays} day${totals.activeDays === 1 ? "" : "s"} of spend`}
            />
            <StatCard
              title="Cost per lead"
              value={totals.costPerLead === null ? "—" : money(totals.costPerLead, ccy)}
              icon={MousePointerClick}
              tone="amber"
              hint={totals.leads === 0 ? "No leads in this range" : undefined}
            />
          </div>

          {best && worst && best.date !== worst.date ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <TrendingDown className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="text-sm">
                    <span className="font-medium">Cheapest lead</span>{" "}
                    <span className="text-muted-foreground">
                      {money(best.costPerLead, ccy)} on {fmtDate(best.date)}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <TrendingUp className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
                  <div className="text-sm">
                    <span className="font-medium">Dearest lead</span>{" "}
                    <span className="text-muted-foreground">
                      {money(worst.costPerLead, ccy)} on {fmtDate(worst.date)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-base">Day by day</CardTitle>
              <p className="text-xs text-muted-foreground">
                Newest first. Each day&apos;s cost per lead is that day&apos;s spend over that
                day&apos;s leads — a dash where there were none.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table dense>
                <THead>
                  <tr>
                    <th>Date</th>
                    <th className="text-right">Spent</th>
                    <th className="text-right">Impressions</th>
                    <th className="text-right">Reach</th>
                    <th className="text-right">Clicks</th>
                    <th className="text-right">CTR</th>
                    <th className="text-right">Leads</th>
                    <th className="text-right">Cost / lead</th>
                  </tr>
                </THead>
                <TBody>
                  {days.map((d) => (
                    <TR key={d.date}>
                      <TD className="whitespace-nowrap tabular-nums">{fmtDate(d.date)}</TD>
                      <TD className="text-right font-medium tabular-nums">
                        {money(d.spend, d.currency)}
                      </TD>
                      <TD className="text-right tabular-nums">{num(d.impressions)}</TD>
                      <TD className="text-right tabular-nums text-muted-foreground">
                        {num(d.reach)}
                      </TD>
                      <TD className="text-right tabular-nums text-muted-foreground">
                        {num(d.clicks)}
                      </TD>
                      <TD className="text-right tabular-nums text-muted-foreground">
                        {d.ctr === null ? "—" : `${d.ctr.toFixed(2)}%`}
                      </TD>
                      <TD className="text-right font-medium tabular-nums">{num(d.leads)}</TD>
                      <TD className="text-right font-medium tabular-nums">
                        {d.costPerLead === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          money(d.costPerLead, d.currency)
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
