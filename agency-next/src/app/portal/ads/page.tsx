import {
  Megaphone,
  Eye,
  MousePointerClick,
  UserRound,
  Target,
  MapPin,
  Users,
  Heart,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { clientAdsSummary } from "@/lib/ads";
import { shortName, shortPlace } from "@/lib/ad-labels";
import { resolveRange } from "@/lib/date-range";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { RangePicker } from "@/components/admin/range-picker";
import { RefreshButton } from "./refresh-button";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "Ads · NVK Media" };
export const dynamic = "force-dynamic";

const num = (n: number) => n.toLocaleString("en-IN");

/** A figure Meta never sent is a dash. It is not a zero, and it never was. */
const orDash = (n: number | null) => (n === null ? "—" : num(n));

/**
 * The client's own ad results.
 *
 * ## No money on this page, at any point
 *
 * Not hidden — absent. `clientAdsSummary` does not select what was paid, so
 * there is no figure here to leak through a careless spread or a column added
 * in a hurry. Cost per lead and CPM are gone for the same reason: both are the
 * same number wearing a different hat, and either one beside a lead count
 * hands it back by arithmetic.
 *
 * Impressions are here, and named. They were taken off once as noise — 538
 * against 99 people is one audience shown the ad five times — but the label
 * was the problem, not the figure: "times shown" reads like a person count,
 * and a client comparing months has nothing to compare without it. Called
 * impressions and set beside accounts reached, the pair says what it is: how
 * often it appeared, and how many people that was.
 *
 * ## Accounts reached is a real figure, not impressions renamed
 *
 * Reach is people; impressions are times shown. On a real account here, 103
 * impressions were 99 people. Calling the larger number "accounts reached"
 * would be flattering and wrong, so it comes from Meta's own deduplicated
 * count for a window, shown with the period it covers. It is never impressions
 * wearing a different label, and when there is no figure at all the card says
 * so rather than substituting the one that is easy to get.
 *
 * ## A dash is not a nought
 *
 * Meta does not report every action type on every account, and it names
 * Instagram profile visits differently across accounts and API versions. An
 * account that never reports one shows a dash. A confident "0 profile visits"
 * would tell a client their ad was ignored when the truth is we do not have
 * the figure.
 */
export default async function PortalAdsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser(["client"]);
  const sp = await searchParams;
  const { from, to, key } = resolveRange(sp.range, sp.from, sp.to);

  const data = user.clientId ? await clientAdsSummary(user.clientId, from, to) : null;
  const t = data?.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Megaphone className="h-6 w-6 text-primary" /> Ads
          </h1>
          {/*
            When the figures are from, beside the button that fetches them
            again. Without it, Refresh is a button that appears to do nothing
            whenever the numbers have not moved.
          */}
          <p className="text-sm text-muted-foreground">
            {fmtDate(from)} – {fmtDate(to)}
            {data?.lastDay ? ` · figures up to ${fmtDate(data.lastDay)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RangePicker current={key} basePath="/portal/ads" />
          <RefreshButton />
        </div>
      </div>

      {!t || t.ads === 0 ? (
        <Card>
          <CardContent className="space-y-2 p-10 text-center">
            <Megaphone className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No ads ran in this period. Try a wider date range, or ask us about starting some.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/*
            In the order they happen: how often it appeared, how many people
            that was, how many reacted, clicked, came and looked, got in
            touch. Each is a step further down the same funnel, so the row
            reads as one story rather than six loose numbers — and the drop
            between any two of them is the interesting part.

            Three across rather than six: six cards on a laptop are six
            columns of about nothing, and this page has been squeezed
            unreadable once already.
          */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/*
              Named impressions, never "times shown" — that label reads as a
              count of people, which is the card immediately after it.
            */}
            <StatCard
              title="Impressions"
              value={num(t.impressions)}
              icon={Eye}
              tone="amber"
              hint="How often the ad appeared, repeats and all"
            />
            {/*
              The period is stated rather than the number withheld.

              Meta deduplicates reach over the window the sync asks for — 28
              days — and this page defaults to a calendar month. Insisting the
              two match left the headline card showing a dash for ever, over a
              three-day difference, when a real figure was sitting right there.
            */}
            <StatCard
              title="Accounts reached"
              value={orDash(t.reach)}
              icon={Users}
              tone="sky"
              hint={
                t.reach === null
                  ? "Not counted yet — ask us to refresh"
                  : t.reachDays
                    ? `Real people, over the last ${t.reachDays} days`
                    : "Real people, counted once each"
              }
            />
            {/*
              Between reached and clicked, because that is where it happens: a
              like or a share is the first and cheapest thing somebody does
              after seeing a post, and a click is the next one up.
            */}
            <StatCard
              title="Engagement"
              value={orDash(t.engagement)}
              icon={Heart}
              tone="rose"
              hint={
                t.engagement === null
                  ? "Not reported for this account"
                  : "Likes, comments, shares and saves"
              }
            />
            <StatCard
              title="Clicks"
              value={num(t.clicks)}
              icon={MousePointerClick}
              tone="indigo"
              hint={t.ctr === null ? undefined : `${t.ctr.toFixed(2)}% of everyone who saw it`}
            />
            <StatCard
              title="Profile visits"
              value={orDash(t.profileVisits)}
              icon={UserRound}
              tone="violet"
              hint={
                t.profileVisits === null
                  ? "Not reported for this account"
                  : "Went and looked at the profile"
              }
            />
            <StatCard
              title="Enquiries"
              value={num(t.leads)}
              icon={Target}
              tone="emerald"
              hint="People who got in touch"
            />
          </div>

          {/*
            The two figures that are neither a funnel step nor money: how many
            ads ran, and how many video views. They sit under the row rather
            than in it, because a count of ads next to a count of people
            invites the two to be read as the same kind of thing.
          */}
          <Card>
            <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2 p-4 text-sm">
              <span className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <b className="tabular-nums">{t.ads}</b>
                <span className="text-muted-foreground">
                  {t.ads === 1 ? "ad ran" : "ads ran"} in this period
                </span>
              </span>
              {t.videoViews === null ? null : (
                <span className="flex items-center gap-2">
                  <b className="tabular-nums">{num(t.videoViews)}</b>
                  <span className="text-muted-foreground">video views</span>
                </span>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-base">Ad by ad</CardTitle>
              <p className="text-xs text-muted-foreground">
                Most-seen first. A dash means Meta did not report that figure for this account —
                it does not mean nobody did it.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {/*
                Sized to its contents and scrolling if it must, rather than
                squeezed into the window — the ad's name is the column that
                says which row you are reading, and it is the first thing a
                fixed layout clips.
              */}
              <div className="w-full overflow-x-auto">
                <Table className="min-w-[62rem] [&_th]:whitespace-nowrap [&_td]:px-3 [&_th]:px-3">
                  <THead>
                    <tr>
                      <th>Ad</th>
                      <th>Where it ran</th>
                      <th className="text-right">Impressions</th>
                      <th className="text-right">Clicks</th>
                      <th className="text-right">Click rate</th>
                      <th className="text-right">Video views</th>
                      <th className="text-right">Engagement</th>
                      <th className="text-right">Profile visits</th>
                      <th className="text-right">Enquiries</th>
                    </tr>
                  </THead>
                  <TBody>
                    {data.ads.map((a) => (
                      <TR key={a.adId}>
                        {/*
                          Their own name is not worth saying to them. "Freskos
                          - Video Ad 5 - Order Now" on Freskos's own page
                          spends half the column on the one word they already
                          know, and pushes the part that tells the ads apart
                          out of sight. Both lines lose it; both keep the full
                          text on the title.
                        */}
                        <TD className="min-w-[14rem]">
                          <span className="block font-medium" title={a.name}>
                            {shortName(a.name, data.company)}
                          </span>
                          {a.campaign ? (
                            <span
                              className="block max-w-[14rem] truncate text-xs text-muted-foreground"
                              title={a.campaign}
                            >
                              {shortName(a.campaign, data.company)}
                            </span>
                          ) : null}
                        </TD>

                        <TD className="whitespace-nowrap">
                          {a.locations ? (
                            <span
                              className="flex items-center gap-1 text-xs"
                              title={a.locations}
                            >
                              <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                              {shortPlace(a.locations)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TD>

                        <TD className="text-right tabular-nums text-muted-foreground">
                          {num(a.impressions)}
                        </TD>
                        <TD className="text-right font-medium tabular-nums">{num(a.clicks)}</TD>
                        <TD className="text-right tabular-nums text-muted-foreground">
                          {a.ctr === null ? "—" : `${a.ctr.toFixed(2)}%`}
                        </TD>
                        <TD className="text-right tabular-nums text-muted-foreground">
                          {orDash(a.videoViews)}
                        </TD>
                        <TD className="text-right tabular-nums">{orDash(a.engagement)}</TD>
                        <TD className="text-right tabular-nums">{orDash(a.profileVisits)}</TD>
                        <TD className="text-right font-medium tabular-nums">{num(a.leads)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
