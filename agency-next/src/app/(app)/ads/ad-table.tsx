/**
 * Ad by ad — which one is working, and which is burning money.
 *
 * The board above answers "what is this costing us". It cannot answer the
 * question anyone asks next, because an account total has no ads in it. This
 * does, and it exists to be acted on: the row somebody reads here is the ad
 * they are about to pause.
 *
 * ## The verdict is named, and so is its basis
 *
 * `rankAds` decides *what* the ads are being judged on rather than this
 * component preferring one measure. Cost per lead when there are leads; click
 * rate when there are none and enough impressions to mean something; a stated
 * reason when neither holds. The basis is written on screen next to the badge,
 * because "best" on click rate and "best" on cost per lead are different
 * claims and a reader who assumes the wrong one pauses the wrong ad.
 *
 * ## Reach is absent on purpose
 *
 * See the note in `ads.ts`: daily reach cannot be summed without counting the
 * same person twice, and a wrong number that looks like the right ones is
 * worse than a missing column.
 */
import Link from "next/link";
import { TrendingUp, TrendingDown, Megaphone, MapPin } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { rankAds, type AdPerf } from "@/lib/ads";
import { shortName, shortPlace, statusLabel } from "@/lib/ad-labels";

/** Money, in whatever currency the ad account reports. */
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

const num = (n: number) => n.toLocaleString("en-IN");

/**
 * The part of the ad's name that is not already in the row.
 *
 * Meta names are written by whoever built the campaign and almost always begin
 * with the client — "Freskos - Followers & Engagement - Liverpool 12km". The
 * Client column is right next to this one, so that prefix is the same word
 * twice while the part that tells the ads apart runs off the end.
 *
 * Only stripped when it is genuinely a prefix followed by a separator, and
 * never when it would leave nothing behind — a name that is only the client's
 * name is still better than an empty cell.
 */
/** A figure Meta never sent is a dash. It is not a zero, and it never was. */
const orDash = (n: number | null) => (n === null ? "—" : num(n));

export function AdTable({
  ads,
  /** Set on the whole-agency board, where one ad's client is not obvious. */
  showClient = false,
  rangeKey,
}: {
  ads: AdPerf[];
  showClient?: boolean;
  rangeKey?: string;
}) {
  const rank = rankAds(ads);

  /*
   * How many ads ran, which is a question in its own right.
   *
   * "How many did we make for this client" was unanswerable from anywhere in
   * the portal — the account total has no count in it. This is ads that
   * actually spent or were shown in the range, not ads that exist in Meta:
   * a paused draft is not work delivered.
   */
  const clients = new Set(ads.map((a) => a.clientId)).size;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          By ad
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {ads.length} {ads.length === 1 ? "ad" : "ads"}
            {showClient && clients > 0
              ? ` · ${clients} ${clients === 1 ? "client" : "clients"}`
              : ""}
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {rank.by === "costPerLead" ? (
            <>
              Biggest spender first. <b>Best</b> and <b>worst</b> are by <b>cost per lead</b> —
              what the money was actually for.
            </>
          ) : rank.by === "ctr" ? (
            <>
              Biggest spender first. No ad has produced a lead yet, so <b>best</b> and{" "}
              <b>worst</b> are by <b>click rate</b> — a weaker signal, and only for ads past{" "}
              enough impressions to judge.
            </>
          ) : (
            <>Biggest spender first. {rank.reason}</>
          )}
        </p>
      </CardHeader>

      <CardContent className="p-0">
        {/*
          Not `dense`, and that is the whole fix for how this looked.
          `dense` means `table-fixed`: twelve columns each take a twelfth of
          the width, so the ad name — the one column that says which row you
          are looking at — was clipped to "Freskos - …" on every line and the
          table became twelve identical rows.

          `table-fixed` is right for the task boards, where every row is a
          link and clipping costs nothing. It is wrong here: this is a table
          somebody reads numbers off, and the name has to survive. So the
          columns size to their contents and the whole thing scrolls sideways
          if it must — which for a board with no buttons on the right is a
          scrollbar that costs nothing.
        */}
        <div className="w-full overflow-x-auto">
          <Table className="min-w-[68rem] [&_th]:whitespace-nowrap [&_td]:px-3 [&_th]:px-3">
          <THead>
            <tr>
              <th>Ad</th>
              {showClient ? <th>Client</th> : null}
              <th>Where</th>
              <th>Status</th>
              <th className="text-right">Spent</th>
              <th className="text-right">Reach</th>
              <th className="text-right">Impressions</th>
              <th className="text-right">Views</th>
              <th className="text-right">Clicks</th>
              <th className="text-right">CTR</th>
              <th className="text-right">Engagement</th>
              <th className="text-right">Leads</th>
              <th className="text-right">Cost / lead</th>
            </tr>
          </THead>
          <TBody>
            {ads.map((a) => {
              const best = rank.best === a.adId;
              const worst = rank.worst === a.adId;
              return (
                <TR key={a.adId}>
                  <TD className="min-w-[15rem]">
                    <div className="flex items-center gap-1.5">
                      {/* The full name is on the title, so nothing is lost. */}
                      <span className="font-medium" title={a.name}>
                        {shortName(a.name, a.client)}
                      </span>
                      {best ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
                          title={
                            rank.by === "costPerLead"
                              ? "Cheapest lead in this range"
                              : "Highest click rate in this range"
                          }
                        >
                          <TrendingUp className="h-3 w-3" /> best
                        </span>
                      ) : null}
                      {worst ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                          title={
                            rank.by === "costPerLead"
                              ? "Dearest lead in this range"
                              : "Lowest click rate in this range"
                          }
                        >
                          <TrendingDown className="h-3 w-3" /> worst
                        </span>
                      ) : null}
                    </div>
                    {a.campaign ? (
                      <div
                        className="max-w-[15rem] truncate text-xs text-muted-foreground"
                        title={a.campaign}
                      >
                        {a.campaign}
                      </div>
                    ) : null}
                  </TD>

                  {showClient ? (
                    <TD className="max-w-[10rem]">
                      <Link
                        href={`/ads/${a.clientId}${rangeKey ? `?range=${rangeKey}` : ""}`}
                        className="truncate transition-colors hover:text-primary hover:underline"
                      >
                        {a.client}
                      </Link>
                    </TD>
                  ) : null}

                  {/*
                    Where it ran. The one thing about an ad that neither the
                    spend nor the click rate can tell you: two ads with
                    identical numbers are completely different pieces of work
                    if one was Hyderabad and the other the whole country.

                    A dash, not "everywhere" — an ad whose targeting we have
                    not read yet is not an ad aimed at the world.
                  */}
                  <TD className="max-w-[11rem]">
                    {a.locations ? (
                      <span
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground"
                        title={a.locations}
                      >
                        <MapPin className="h-3 w-3 shrink-0" />
                        {/*
                          A pin's name is a full postal address — "1 Secant St,
                          Sydney, New South Wales, Australia +12km" — and at any
                          sane column width that clips to "1 Secant St,", which
                          is the least useful half of it. The suburb and the
                          radius are what somebody is reading for; the whole
                          address is on the title.
                        */}
                        {shortPlace(a.locations)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>

                  {/*
                    Whether it is still delivering. An ad with yesterday's
                    numbers and a paused ad set looks identical to a live one
                    on every other column.
                  */}
                  <TD>
                    {statusLabel(a.status) ? (
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap text-xs ${
                          statusLabel(a.status)!.live ? "text-success" : "text-muted-foreground"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            statusLabel(a.status)!.live ? "bg-success" : "bg-muted-foreground/50"
                          }`}
                        />
                        {statusLabel(a.status)!.text}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>

                  <TD className="text-right font-medium tabular-nums">
                    {money(a.spend, a.currency)}
                  </TD>

                  {/*
                    People, not events — and never a sum of daily figures. A
                    dash means the range on screen is not the range Meta
                    deduplicated it over, which is the only honest answer:
                    reach quoted against the wrong period looks precise, is
                    roughly right, and nobody can tell which.
                  */}
                  <TD
                    className="text-right tabular-nums text-muted-foreground"
                    title={
                      a.reach === null
                        ? "Reach cannot be added up across days. It is only shown for the period Meta counted it over."
                        : undefined
                    }
                  >
                    {orDash(a.reach)}
                  </TD>
                  <TD className="text-right tabular-nums">{num(a.impressions)}</TD>
                  <TD className="text-right tabular-nums text-muted-foreground">
                    {orDash(a.videoViews)}
                  </TD>
                  <TD className="text-right tabular-nums text-muted-foreground">
                    {num(a.clicks)}
                  </TD>
                  <TD className="text-right tabular-nums text-muted-foreground">
                    {a.ctr === null ? "—" : `${a.ctr.toFixed(2)}%`}
                  </TD>
                  <TD className="text-right tabular-nums text-muted-foreground">
                    {orDash(a.engagement)}
                  </TD>
                  <TD className="text-right font-medium tabular-nums">{num(a.leads)}</TD>
                  {/* A dash, not a zero. No leads is not a cheap lead. */}
                  <TD className="text-right font-medium tabular-nums">
                    {a.costPerLead === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      money(a.costPerLead, a.currency)
                    )}
                  </TD>

                </TR>
              );
            })}
          </TBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
