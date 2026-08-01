import Link from "next/link";
import { ExternalLink, Radio, Users, TrendingUp, Eye } from "lucide-react";
import { requireUser } from "@/lib/auth";
import {
  analyticsReady,
  getComparedTotals,
  getSeries,
  getTopPosts,
  getEngagementBreakdown,
  getLastSyncDate,
  type AnalyticsFilters,
} from "@/lib/analytics";
import { getRecommendations } from "@/lib/insights-ai";
import { parseFilters, formatRange, RANGE_OPTIONS } from "@/lib/analytics-filters";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Select } from "@/components/ui/select";
import { buttonClasses } from "@/components/ui/button";
import { GrowthBadge } from "@/components/admin/growth-badge";
import {
  TrendChart,
  BarChart,
  FollowersChart,
  ChartTable,
} from "@/components/admin/analytics-charts";

export const metadata = { title: "Performance · Client Portal" };
export const dynamic = "force-dynamic";

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));
const compact = (n: number) =>
  new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/**
 * The client's own performance view.
 *
 * Deliberately narrower than the admin dashboard. A client wants to know
 * whether the work is landing — not to slice by campaign or compare themselves
 * against the agency's other accounts. Everything here is scoped to their own
 * `clientId` from the session, never from the query string, so no filter can
 * be edited into showing somebody else's numbers.
 */
export default async function PortalAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser(["client"]);
  const sp = await searchParams;
  const filters = parseFilters(sp);

  if (!user.clientId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          This login isn&apos;t linked to a client account yet.
        </CardContent>
      </Card>
    );
  }

  if (!(await analyticsReady())) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Performance tracking isn&apos;t switched on for this account yet. Your account manager
          can enable it.
        </CardContent>
      </Card>
    );
  }

  // clientId comes from the session, not the URL — the one line that makes this
  // page safe to expose to a client.
  const f: AnalyticsFilters = {
    clientId: user.clientId,
    from: filters.from,
    to: filters.to,
    platform: "instagram",
  };

  const [compared, daily, weekly, topPosts, engagement, recommendations, lastSync] =
    await Promise.all([
      getComparedTotals(f),
      getSeries(f, "day"),
      getSeries(f, "week"),
      getTopPosts(f, 5),
      getEngagementBreakdown(f),
      getRecommendations(user.clientId),
      getLastSyncDate(user.clientId),
    ]);

  const { current, growth, previousRange } = compared;
  const hasData = current.reach > 0 || current.followers > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Performance</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatRange(filters.from, filters.to)}
            <span className="text-muted-foreground/60">
              {" · vs "}
              {formatRange(previousRange.from, previousRange.to)}
            </span>
            {lastSync ? (
              <span className="text-muted-foreground/60"> · updated to {lastSync}</span>
            ) : null}
          </p>
        </div>

        {/* Just the period — the only choice that changes what this page means
            for a client. */}
        <form method="GET" className="flex items-center gap-2">
          <Select
            name="range"
            defaultValue={filters.range}
            aria-label="Period"
            className="h-9 w-40 text-sm"
          >
            {RANGE_OPTIONS.filter((r) => r.key !== "custom").map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
          <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
            Show
          </button>
        </form>
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No figures for this period yet. Instagram data arrives the day after a post goes out,
            so a brand new account shows numbers from tomorrow.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="People reached"
          value={compact(current.reach)}
          hint={<GrowthBadge value={growth.reach} />}
          icon={Radio}
          tone="orange"
        />
        <StatCard
          title="Views"
          value={compact(current.views)}
          hint={<GrowthBadge value={growth.views} />}
          icon={Eye}
          tone="sky"
        />
        <StatCard
          title="Followers"
          value={compact(current.followers)}
          hint={
            <span className="tabular-nums">
              {current.followerGrowth >= 0 ? "+" : ""}
              {fmt(current.followerGrowth)} this period
            </span>
          }
          icon={Users}
          tone="emerald"
        />
        <StatCard
          title="Engagement rate"
          value={`${current.engagementRate.toFixed(1)}%`}
          hint={<GrowthBadge value={growth.engagementRate} />}
          icon={TrendingUp}
          tone="amber"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Reach, day by day</CardTitle>
            <p className="text-xs text-muted-foreground">
              How many separate people saw your content each day.
            </p>
          </CardHeader>
          <CardContent>
            <TrendChart data={daily} series={[{ key: "reach", label: "Reach" }]} area />
            <ChartTable
              columns={["Date", "Reach", "Views"]}
              rows={daily.map((d) => [d.bucket, d.reach, d.views])}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Followers</CardTitle>
            <p className="text-xs text-muted-foreground">Your audience over the same period.</p>
          </CardHeader>
          <CardContent>
            <FollowersChart data={daily} />
            <ChartTable
              columns={["Date", "Followers", "Change"]}
              rows={daily
                .filter((d) => d.followers > 0)
                .map((d) => [d.bucket, d.followers, d.followerDelta])}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Reach by week</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              labels={weekly.map((w) => w.bucket)}
              series={[{ label: "Reach", data: weekly.map((w) => w.reach) }]}
            />
            <ChartTable
              columns={["Week", "Reach", "Interactions"]}
              rows={weekly.map((w) => [w.bucket, w.reach, w.interactions])}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">How people responded</CardTitle>
            <p className="text-xs text-muted-foreground">
              Saves and shares matter most — they&apos;re what pushes a post to new people.
            </p>
          </CardHeader>
          <CardContent>
            <BarChart
              labels={["Likes", "Comments", "Shares", "Saves"]}
              series={[
                {
                  label: "Interactions",
                  data: [engagement.likes, engagement.comments, engagement.shares, engagement.saves],
                },
              ]}
            />
            <ChartTable
              columns={["Interaction", "Count"]}
              rows={[
                ["Likes", engagement.likes],
                ["Comments", engagement.comments],
                ["Shares", engagement.shares],
                ["Saves", engagement.saves],
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {topPosts.length ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Your best posts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Post</th>
                    <th className="px-3 py-2 text-right font-medium">Reach</th>
                    <th className="px-3 py-2 text-right font-medium">Likes</th>
                    <th className="px-3 py-2 text-right font-medium">Saves</th>
                    <th className="px-3 py-2 text-right font-medium">Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {topPosts.map((p) => (
                    <tr key={p.mediaId} className="border-b border-border last:border-0">
                      <td className="max-w-[20rem] px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate">
                            {p.title || p.caption?.slice(0, 60) || "Untitled post"}
                          </span>
                          {p.permalink ? (
                            <a
                              href={p.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-muted-foreground hover:text-primary"
                              aria-label="Open on Instagram"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.reach)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.likes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.saves)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {p.engagementRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {recommendations.length ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">What we&apos;re doing next</CardTitle>
            <p className="text-xs text-muted-foreground">
              Drawn from your own account&apos;s numbers.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {recommendations.map((r) => (
              <div key={r.kind} className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium">{r.headline}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {r.detail}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        Questions about any of this?{" "}
        <Link href="/portal/content" className="text-primary hover:underline">
          See what&apos;s in production
        </Link>
        .
      </p>
    </div>
  );
}
