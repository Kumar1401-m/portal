import Link from "next/link";
import {
  Users,
  Eye,
  Heart,
  MousePointerClick,
  TrendingUp,
  Radio,
  FileDown,
  Printer,
  Database,
  ExternalLink,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import {
  analyticsReady,
  getComparedTotals,
  getSeries,
  getTopPosts,
  getEngagementBreakdown,
  getPostingFrequency,
  getContentTypePerformance,
  getClientPerformance,
  getAnalyticsClients,
  getCampaigns,
  getLastSyncDate,
  type AnalyticsFilters,
} from "@/lib/analytics";
import { getRecommendations } from "@/lib/insights-ai";
import { parseFilters, buildQuery, formatRange } from "@/lib/analytics-filters";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { GrowthBadge } from "@/components/admin/growth-badge";
import { AnalyticsFilterBar } from "./filter-bar";
import {
  TrendChart,
  BarChart,
  FollowersChart,
  ChartTable,
} from "@/components/admin/analytics-charts";

export const metadata = { title: "Analytics · NVK Hub" };
export const dynamic = "force-dynamic";

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));
const compact = (n: number) =>
  new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** A chart in the standard card, so every card on the page has one anatomy. */
function ChartCard({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const filters = parseFilters(sp);

  // A crm user only ever sees the clients assigned to them; null means
  // unrestricted (admin / super admin).
  const allowedClientIds = await crmClientIds(user);

  if (!(await analyticsReady())) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <Card>
          <CardContent className="flex items-start gap-3 p-6">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-2">
              <p className="font-medium">The analytics tables aren&apos;t set up yet.</p>
              <p className="text-sm text-muted-foreground">
                Run <code className="rounded bg-muted px-1">node database/migrate.js</code>, or
                apply the pending changes from Settings without needing a terminal.
              </p>
              <Link href="/settings" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                Open Settings
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const f: AnalyticsFilters = {
    clientId: filters.clientId,
    from: filters.from,
    to: filters.to,
    platform: filters.platform,
    campaign: filters.campaign,
    allowedClientIds,
  };

  // Every query for the page runs concurrently — they're independent reads and
  // running them in sequence would make the page as slow as their sum.
  const [
    compared,
    daily,
    weekly,
    monthly,
    topPosts,
    engagement,
    frequency,
    contentTypes,
    clientRows,
    clients,
    campaigns,
    lastSync,
  ] = await Promise.all([
    getComparedTotals(f),
    getSeries(f, "day"),
    getSeries(f, "week"),
    getSeries(f, "month"),
    getTopPosts(f, 8),
    getEngagementBreakdown(f),
    getPostingFrequency(f, "week"),
    getContentTypePerformance(f),
    getClientPerformance(f),
    getAnalyticsClients(allowedClientIds),
    getCampaigns(allowedClientIds),
    getLastSyncDate(filters.clientId),
  ]);

  // Recommendations are per-client by nature — "post at 6 PM on Thursday" is
  // not a statement you can make about twelve different businesses at once.
  const recommendations = filters.clientId ? await getRecommendations(filters.clientId) : [];

  const { current, previous, growth, previousRange } = compared;
  const selectedClient = clients.find((c) => c.id === filters.clientId);
  const exportQuery = buildQuery(filters, {});

  const hasData = current.reach > 0 || current.postsCount > 0 || current.followers > 0;

  return (
    <div className="space-y-5">
      {/* ---------------------------------- Header --------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {selectedClient ? selectedClient.company_name : "Analytics"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatRange(filters.from, filters.to)}
            <span className="text-muted-foreground/60">
              {" · compared with "}
              {formatRange(previousRange.from, previousRange.to)}
            </span>
            {lastSync ? (
              <span className="text-muted-foreground/60"> · data through {lastSync}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/analytics/export${exportQuery}`}
            className={buttonClasses({ variant: "secondary", size: "sm" })}
            // Not a client-side navigation: this route returns a file, and
            // Next's router would try to render the CSV as a page.
            prefetch={false}
          >
            <FileDown className="h-3.5 w-3.5" /> Excel / CSV
          </Link>
          <Link
            href={`/analytics/print${exportQuery}`}
            target="_blank"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
            prefetch={false}
          >
            <Printer className="h-3.5 w-3.5" /> PDF
          </Link>
        </div>
      </div>

      {/* One filter row, above everything it scopes. */}
      <AnalyticsFilterBar
        basePath="/analytics"
        filters={filters}
        clients={clients}
        campaigns={campaigns}
      />

      {!hasData ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing collected for this period yet. The daily insights job writes yesterday&apos;s
            numbers each morning — a brand new connection has its first data the following day.
            {filters.campaign ? (
              <>
                {" "}
                This view is also filtered to the <b>{filters.campaign}</b> campaign, which only
                covers posts published through the portal.
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* --------------------------------- Headlines -------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          title="Reach"
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
            <span className="inline-flex items-center gap-1">
              <span className="tabular-nums">
                {current.followerGrowth >= 0 ? "+" : ""}
                {fmt(current.followerGrowth)}
              </span>
              <GrowthBadge value={growth.followerGrowth} />
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
        <StatCard
          title="Accounts engaged"
          value={compact(current.accountsEngaged)}
          hint={<GrowthBadge value={growth.accountsEngaged} />}
          icon={Heart}
          tone="rose"
        />
        <StatCard
          title="Profile visits"
          value={compact(current.profileVisits)}
          hint={<GrowthBadge value={growth.profileVisits} />}
          icon={MousePointerClick}
          tone="violet"
        />
      </div>

      {/* ---------------------------------- Trends ---------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Daily reach"
          hint="How many separate accounts saw this content each day."
        >
          <TrendChart data={daily} series={[{ key: "reach", label: "Reach" }]} area />
          <ChartTable
            columns={["Date", "Reach", "Views", "Interactions"]}
            rows={daily.map((d) => [d.bucket, d.reach, d.views, d.interactions])}
          />
        </ChartCard>

        <ChartCard title="Weekly reach" hint="The same figure grouped into ISO weeks (Mon–Sun).">
          <BarChart
            labels={weekly.map((w) => w.bucket)}
            series={[{ label: "Reach", data: weekly.map((w) => w.reach) }]}
          />
          <ChartTable
            columns={["Week", "Reach", "Interactions"]}
            rows={weekly.map((w) => [w.bucket, w.reach, w.interactions])}
          />
        </ChartCard>

        <ChartCard title="Monthly reach" hint="Long-run direction, once a few months exist.">
          <BarChart
            labels={monthly.map((m) => m.bucket)}
            series={[{ label: "Reach", data: monthly.map((m) => m.reach) }]}
          />
          <ChartTable
            columns={["Month", "Reach", "Views", "Interactions"]}
            rows={monthly.map((m) => [m.bucket, m.reach, m.views, m.interactions])}
          />
        </ChartCard>

        <ChartCard
          title="Followers"
          hint="The running total. The axis doesn't start at zero — that would flatten real movement into a straight line."
        >
          <FollowersChart data={daily} />
          <ChartTable
            columns={["Date", "Followers", "Change"]}
            rows={daily
              .filter((d) => d.followers > 0)
              .map((d) => [d.bucket, d.followers, d.followerDelta])}
          />
        </ChartCard>

        <ChartCard
          title="Engagement rate"
          hint="Interactions as a share of reach — a quality signal that doesn't move with audience size."
        >
          <TrendChart
            data={daily.map((d) => ({ bucket: d.bucket, rate: d.engagementRate }))}
            series={[{ key: "rate", label: "Engagement rate %" }]}
            area
          />
          <ChartTable
            columns={["Date", "Rate %", "Interactions", "Reach"]}
            rows={daily.map((d) => [d.bucket, d.engagementRate, d.interactions, d.reach])}
          />
        </ChartCard>

        <ChartCard
          title="Views vs reach"
          hint="Both are counts of the same audience, so they share one axis. Views well above reach means people watched more than once."
        >
          <TrendChart
            data={daily}
            series={[
              { key: "views", label: "Views" },
              { key: "reach", label: "Reach" },
            ]}
          />
          <ChartTable
            columns={["Date", "Views", "Reach"]}
            rows={daily.map((d) => [d.bucket, d.views, d.reach])}
          />
        </ChartCard>
      </div>

      {/* ------------------------------- Interactions ------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="Interaction mix"
          hint="Saves and shares are worth more than likes — they're what Instagram treats as intent."
        >
          <BarChart
            labels={["Likes", "Comments", "Shares", "Saves"]}
            series={[
              {
                label: "Interactions",
                data: [
                  engagement.likes,
                  engagement.comments,
                  engagement.shares,
                  engagement.saves,
                ],
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
        </ChartCard>

        <ChartCard
          title="Posting frequency"
          hint="Posts published per week, against what they reached."
        >
          <BarChart
            labels={frequency.map((p) => p.bucket)}
            series={[{ label: "Posts", data: frequency.map((p) => p.posts) }]}
          />
          <ChartTable
            columns={["Week", "Posts", "Reach"]}
            rows={frequency.map((p) => [p.bucket, p.posts, p.reach])}
          />
        </ChartCard>

        <ChartCard
          title="Format performance"
          hint="Average engagement rate by content category."
        >
          <BarChart
            labels={contentTypes.slice(0, 6).map((c) => c.label)}
            series={[
              {
                label: "Avg engagement %",
                data: contentTypes.slice(0, 6).map((c) => c.avgEngagementRate),
              },
            ]}
            horizontal
          />
          <ChartTable
            columns={["Format", "Posts", "Avg ER %", "Avg reach"]}
            rows={contentTypes.map((c) => [
              c.label,
              c.posts,
              c.avgEngagementRate,
              c.avgReach,
            ])}
          />
        </ChartCard>
      </div>

      {/* ---------------------------- AI recommendations ---------------------------- */}
      {filters.clientId ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">What to change next</CardTitle>
            <p className="text-xs text-muted-foreground">
              Computed from this account&apos;s own history, then written up. Refreshed by the
              daily insights job.
            </p>
          </CardHeader>
          <CardContent>
            {recommendations.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {recommendations.map((r) => (
                  <div key={r.kind} className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{r.headline}</p>
                      {/* Sample size, stated plainly — advice from four posts
                          should not look as certain as advice from forty. */}
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {Math.round(Number(r.confidence) * 100)}% confidence
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {r.detail}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No recommendations yet — they appear once there are enough posts with metrics to
                draw a pattern from.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* -------------------------------- Top posts -------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Best performing posts</CardTitle>
          <p className="text-xs text-muted-foreground">
            Ranked by engagement rate rather than raw likes — a post that reached 500 people and
            moved 100 of them taught us more than one that reached 50,000 and moved 200.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {topPosts.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Post</th>
                    {!filters.clientId ? (
                      <th className="px-3 py-2 text-left font-medium">Client</th>
                    ) : null}
                    <th className="px-3 py-2 text-left font-medium">Published</th>
                    <th className="px-3 py-2 text-right font-medium">Reach</th>
                    <th className="px-3 py-2 text-right font-medium">Likes</th>
                    <th className="px-3 py-2 text-right font-medium">Comments</th>
                    <th className="px-3 py-2 text-right font-medium">Shares</th>
                    <th className="px-3 py-2 text-right font-medium">Saves</th>
                    <th className="px-3 py-2 text-right font-medium">ER</th>
                  </tr>
                </thead>
                <tbody>
                  {topPosts.map((p, i) => (
                    <tr key={p.mediaId} className="border-b border-border last:border-0">
                      <td className="max-w-[22rem] px-4 py-2">
                        <div className="flex items-center gap-2">
                          {/* The top row is the answer to "what worked?", so
                              it's marked rather than left to be counted. */}
                          {i === 0 ? (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              Best
                            </span>
                          ) : null}
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
                      {!filters.clientId ? (
                        <td className="px-3 py-2 text-muted-foreground">{p.clientName || "—"}</td>
                      ) : null}
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {p.publishedAt ? p.publishedAt.slice(0, 10) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.reach)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.likes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.comments)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.shares)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(p.saves)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {p.engagementRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No posts with metrics in this period.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------ Client-by-client ----------------------------- */}
      {!filters.clientId && clientRows.length > 1 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">By client</CardTitle>
            <p className="text-xs text-muted-foreground">
              Every account you have access to, over the same period.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Client</th>
                    <th className="px-3 py-2 text-right font-medium">Followers</th>
                    <th className="px-3 py-2 text-right font-medium">Growth</th>
                    <th className="px-3 py-2 text-right font-medium">Reach</th>
                    <th className="px-3 py-2 text-right font-medium">Views</th>
                    <th className="px-3 py-2 text-right font-medium">Interactions</th>
                    <th className="px-3 py-2 text-right font-medium">ER</th>
                    <th className="px-3 py-2 text-right font-medium">Posts</th>
                  </tr>
                </thead>
                <tbody>
                  {clientRows.map((c) => (
                    <tr key={c.clientId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/analytics${buildQuery(filters, { clientId: c.clientId })}`}
                          className="font-medium hover:text-primary"
                        >
                          {c.clientName}
                        </Link>
                        {c.igUsername ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            @{c.igUsername}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(c.followers)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={
                            c.followerGrowth > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : c.followerGrowth < 0
                                ? "text-rose-600 dark:text-rose-400"
                                : "text-muted-foreground"
                          }
                        >
                          {c.followerGrowth > 0 ? "+" : ""}
                          {fmt(c.followerGrowth)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(c.reach)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(c.views)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(c.interactions)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {c.engagementRate.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(c.posts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------- Month-over-month table --------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">This period vs last</CardTitle>
          <p className="text-xs text-muted-foreground">
            {formatRange(filters.from, filters.to)} against the equally long period before it
            ({formatRange(previousRange.from, previousRange.to)}).
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr className="text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Metric</th>
                  <th className="px-3 py-2 text-right font-medium">This period</th>
                  <th className="px-3 py-2 text-right font-medium">Previous</th>
                  <th className="px-3 py-2 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Reach", "reach"],
                    ["Views", "views"],
                    ["Impressions", "impressions"],
                    ["Accounts engaged", "accountsEngaged"],
                    ["Likes", "likes"],
                    ["Comments", "comments"],
                    ["Shares", "shares"],
                    ["Saves", "saves"],
                    ["Reel plays", "reelPlays"],
                    ["Profile visits", "profileVisits"],
                    ["Website clicks", "websiteClicks"],
                    ["Follower growth", "followerGrowth"],
                    ["Posts published", "postsCount"],
                  ] as const
                ).map(([label, key]) => (
                  <tr key={key} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{label}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {fmt(current[key])}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {fmt(previous[key])}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <GrowthBadge value={growth[key]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
