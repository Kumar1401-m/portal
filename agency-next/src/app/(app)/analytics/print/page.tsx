import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { queryOne } from "@/lib/db";
import {
  analyticsReady,
  getComparedTotals,
  getSeries,
  getTopPosts,
  getEngagementBreakdown,
  getClientPerformance,
  type AnalyticsFilters,
  type MetricTotals,
} from "@/lib/analytics";
import { getRecommendations } from "@/lib/insights-ai";
import { parseFilters, formatRange } from "@/lib/analytics-filters";
import { getSettings } from "@/lib/settings";
import { TrendChart, BarChart } from "@/components/admin/analytics-charts";
import { PrintButton } from "./print-button";

export const metadata = { title: "Analytics report" };
export const dynamic = "force-dynamic";

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Growth for print. No coloured pills: a report is often printed in greyscale
 * or on a monochrome office printer, so the arrow and the sign carry the
 * meaning and colour is only reinforcement.
 */
function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[11px] text-slate-500">new</span>;
  if (value === 0) return <span className="text-[11px] text-slate-500">—</span>;
  return (
    <span className={value > 0 ? "text-emerald-700" : "text-rose-700"}>
      {value > 0 ? "▲" : "▼"} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

/**
 * The printable performance report.
 *
 * Its own page rather than a print stylesheet over the dashboard: the dashboard
 * has a sidebar, a filter bar and interactive controls, none of which belong on
 * paper, and hiding them all with `display: none` is a losing battle every time
 * the dashboard changes. This page renders only what should be printed.
 */
export default async function AnalyticsPrintPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const allowedClientIds = await crmClientIds(user);

  if (!(await analyticsReady())) {
    return <p className="p-8 text-sm">The analytics tables are not set up yet.</p>;
  }

  const f: AnalyticsFilters = {
    clientId: filters.clientId,
    from: filters.from,
    to: filters.to,
    platform: filters.platform,
    campaign: filters.campaign,
    allowedClientIds,
  };

  const [compared, daily, weekly, topPosts, engagement, clientRows, client, settings] =
    await Promise.all([
      getComparedTotals(f),
      getSeries(f, "day"),
      getSeries(f, "week"),
      getTopPosts(f, 10),
      getEngagementBreakdown(f),
      getClientPerformance(f),
      filters.clientId
        ? queryOne<{ company_name: string; ig_username: string | null }>(
            "SELECT company_name, ig_username FROM clients WHERE id = ?",
            [filters.clientId]
          )
        : Promise.resolve(null),
      getSettings(),
    ]);

  const { current, previous, growth, previousRange } = compared;
  const recommendations = filters.clientId ? await getRecommendations(filters.clientId) : [];

  const metrics: [string, keyof MetricTotals][] = [
    ["Reach", "reach"],
    ["Views", "views"],
    ["Accounts engaged", "accountsEngaged"],
    ["Likes", "likes"],
    ["Comments", "comments"],
    ["Shares", "shares"],
    ["Saves", "saves"],
    ["Profile visits", "profileVisits"],
    ["Website clicks", "websiteClicks"],
    ["Follower growth", "followerGrowth"],
    ["Posts published", "postsCount"],
  ];

  return (
    <>
      {/*
        Print rules. `print-color-adjust` is what stops the browser dropping
        chart fills and table shading to save ink — without it every chart
        prints as an empty outline.
      */}
      <style>{`
        @page { size: A4; margin: 14mm 12mm; }
        @media print {
          .no-print { display: none !important; }
          .print-page { box-shadow: none !important; padding: 0 !important; }
          .print-break { break-inside: avoid; page-break-inside: avoid; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="mx-auto max-w-[820px] space-y-5 bg-white p-6 text-slate-900 print-page">
        <div className="no-print flex justify-end">
          <PrintButton />
        </div>

        {/* --------------------------------- Header -------------------------------- */}
        <header className="border-b-2 border-orange-600 pb-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
                {settings.company_name || "Instagram performance report"}
              </p>
              <h1 className="mt-1 text-2xl font-bold">
                {client?.company_name || "All clients"}
                {client?.ig_username ? (
                  <span className="ml-2 text-base font-normal text-slate-500">
                    @{client.ig_username}
                  </span>
                ) : null}
              </h1>
            </div>
            <div className="text-right text-xs text-slate-600">
              <p className="font-medium">{formatRange(filters.from, filters.to)}</p>
              <p>vs {formatRange(previousRange.from, previousRange.to)}</p>
            </div>
          </div>
        </header>

        {/* -------------------------------- Headlines ------------------------------- */}
        <section className="print-break grid grid-cols-4 gap-3">
          {(
            [
              ["Reach", fmt(current.reach), growth.reach],
              ["Followers", fmt(current.followers), growth.followerGrowth],
              ["Engagement", `${current.engagementRate.toFixed(1)}%`, growth.engagementRate],
              ["Posts", fmt(current.postsCount), growth.postsCount],
            ] as const
          ).map(([label, value, change]) => (
            <div key={label} className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold">{value}</p>
              <p className="mt-0.5 text-[11px]">
                <Change value={change} />
              </p>
            </div>
          ))}
        </section>

        {/* ---------------------------------- Charts -------------------------------- */}
        <section className="print-break">
          <h2 className="mb-2 text-sm font-semibold">Reach over time</h2>
          <TrendChart data={daily} series={[{ key: "reach", label: "Reach" }]} height={200} area />
        </section>

        <section className="print-break grid grid-cols-2 gap-5">
          <div>
            <h2 className="mb-2 text-sm font-semibold">Reach by week</h2>
            <BarChart
              labels={weekly.map((w) => w.bucket)}
              series={[{ label: "Reach", data: weekly.map((w) => w.reach) }]}
              height={180}
            />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold">Interaction mix</h2>
            <BarChart
              labels={["Likes", "Comments", "Shares", "Saves"]}
              series={[
                {
                  label: "Interactions",
                  data: [engagement.likes, engagement.comments, engagement.shares, engagement.saves],
                },
              ]}
              height={180}
            />
          </div>
        </section>

        {/* --------------------------------- Metrics -------------------------------- */}
        <section className="print-break">
          <h2 className="mb-2 text-sm font-semibold">Every metric</h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-300 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-1.5 text-left font-medium">Metric</th>
                <th className="py-1.5 text-right font-medium">This period</th>
                <th className="py-1.5 text-right font-medium">Previous</th>
                <th className="py-1.5 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([label, key]) => (
                <tr key={key} className="border-b border-slate-100">
                  <td className="py-1.5">{label}</td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{fmt(current[key])}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">
                    {fmt(previous[key])}
                  </td>
                  <td className="py-1.5 text-right">
                    <Change value={growth[key]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* -------------------------------- Top posts ------------------------------- */}
        {topPosts.length ? (
          <section className="print-break">
            <h2 className="mb-2 text-sm font-semibold">Best performing posts</h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-300 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 text-left font-medium">Post</th>
                  <th className="py-1.5 text-right font-medium">Reach</th>
                  <th className="py-1.5 text-right font-medium">Likes</th>
                  <th className="py-1.5 text-right font-medium">Saves</th>
                  <th className="py-1.5 text-right font-medium">ER</th>
                </tr>
              </thead>
              <tbody>
                {topPosts.map((p) => (
                  <tr key={p.mediaId} className="border-b border-slate-100">
                    <td className="max-w-[24rem] truncate py-1.5">
                      {p.title || p.caption?.slice(0, 70) || "Untitled post"}
                      {!filters.clientId && p.clientName ? (
                        <span className="ml-1.5 text-slate-500">· {p.clientName}</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.reach)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.likes)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.saves)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">
                      {p.engagementRate.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {/* ------------------------------- By client -------------------------------- */}
        {!filters.clientId && clientRows.length > 1 ? (
          <section className="print-break">
            <h2 className="mb-2 text-sm font-semibold">By client</h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-300 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 text-left font-medium">Client</th>
                  <th className="py-1.5 text-right font-medium">Followers</th>
                  <th className="py-1.5 text-right font-medium">Growth</th>
                  <th className="py-1.5 text-right font-medium">Reach</th>
                  <th className="py-1.5 text-right font-medium">ER</th>
                  <th className="py-1.5 text-right font-medium">Posts</th>
                </tr>
              </thead>
              <tbody>
                {clientRows.map((c) => (
                  <tr key={c.clientId} className="border-b border-slate-100">
                    <td className="py-1.5">{c.clientName}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(c.followers)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {c.followerGrowth > 0 ? "+" : ""}
                      {fmt(c.followerGrowth)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(c.reach)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {c.engagementRate.toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(c.posts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {/* ----------------------------- Recommendations ---------------------------- */}
        {recommendations.length ? (
          <section className="print-break">
            <h2 className="mb-2 text-sm font-semibold">What we&apos;d change next</h2>
            <ul className="space-y-2">
              {recommendations.map((r) => (
                <li key={r.kind} className="rounded border border-slate-200 p-2.5">
                  <p className="text-xs font-semibold">{r.headline}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600">
                    {r.detail}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="border-t border-slate-200 pt-2 text-[10px] text-slate-500">
          Generated {new Date().toLocaleDateString("en-IN", { dateStyle: "long" })} ·{" "}
          {settings.company_name || "Agency"} · Figures from Instagram Insights via the Meta Graph
          API.
        </footer>
      </div>
    </>
  );
}
