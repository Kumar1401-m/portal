/**
 * GET /analytics/export?<the dashboard's own filters>
 *
 * The dashboard's current view as a spreadsheet. Takes exactly the same query
 * string as the page, so what downloads is what is on screen — a different
 * parameter set here would be a second, quietly diverging definition of the
 * same numbers.
 *
 * Session-authenticated and role-scoped like the page it exports, not part of
 * the automation API: a crm user's export must contain only their clients.
 */
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import {
  analyticsReady,
  getComparedTotals,
  getSeries,
  getTopPosts,
  getClientPerformance,
  getContentTypePerformance,
  type AnalyticsFilters,
} from "@/lib/analytics";
import { parseFilters } from "@/lib/analytics-filters";
import { toCsvWorkbook, csvFilename, csvResponse, type CsvSection } from "@/lib/csv";
import { queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

/** null → "new"; the sheet says so rather than showing an empty cell. */
const growthCell = (v: number | null) => (v === null ? "new" : `${v.toFixed(1)}%`);

export async function GET(request: Request) {
  // requireUser redirects an unauthenticated caller, so the export can never
  // be fetched by a stray link without a session.
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  if (!(await analyticsReady())) {
    return new Response("Analytics tables are not set up yet.", { status: 503 });
  }

  const url = new URL(request.url);
  const filters = parseFilters(Object.fromEntries(url.searchParams.entries()));
  const allowedClientIds = await crmClientIds(user);

  const f: AnalyticsFilters = {
    clientId: filters.clientId,
    from: filters.from,
    to: filters.to,
    platform: filters.platform,
    campaign: filters.campaign,
    allowedClientIds,
  };

  const [compared, daily, weekly, topPosts, clientRows, formats, client] = await Promise.all([
    getComparedTotals(f),
    getSeries(f, "day"),
    getSeries(f, "week"),
    getTopPosts(f, 50),
    getClientPerformance(f),
    getContentTypePerformance(f),
    filters.clientId
      ? queryOne<{ company_name: string }>("SELECT company_name FROM clients WHERE id = ?", [
          filters.clientId,
        ])
      : Promise.resolve(null),
  ]);

  const { current, previous, growth, previousRange } = compared;

  const sections: CsvSection[] = [
    {
      title: `Instagram analytics — ${client?.company_name || "All clients"} — ${filters.from} to ${filters.to}`,
      headers: ["Metric", "This period", `Previous (${previousRange.from} to ${previousRange.to})`, "Change"],
      rows: (
        [
          ["Reach", "reach"],
          ["Views", "views"],
          ["Impressions", "impressions"],
          ["Accounts engaged", "accountsEngaged"],
          ["Likes", "likes"],
          ["Comments", "comments"],
          ["Shares", "shares"],
          ["Saves", "saves"],
          ["Total interactions", "totalInteractions"],
          ["Reel plays", "reelPlays"],
          ["Profile visits", "profileVisits"],
          ["Website clicks", "websiteClicks"],
          ["Follower growth", "followerGrowth"],
          ["Followers (latest)", "followers"],
          ["Posts published", "postsCount"],
          ["Engagement rate %", "engagementRate"],
        ] as const
      ).map(([label, key]) => [label, current[key], previous[key], growthCell(growth[key])]),
    },
    {
      title: "Daily series",
      headers: [
        "Date",
        "Reach",
        "Views",
        "Impressions",
        "Interactions",
        "Followers",
        "Follower change",
        "Profile visits",
        "Engagement rate %",
      ],
      rows: daily.map((d) => [
        d.bucket,
        d.reach,
        d.views,
        d.impressions,
        d.interactions,
        d.followers,
        d.followerDelta,
        d.profileVisits,
        d.engagementRate,
      ]),
    },
    {
      title: "Weekly series",
      headers: ["Week", "Reach", "Views", "Interactions", "Engagement rate %"],
      rows: weekly.map((w) => [w.bucket, w.reach, w.views, w.interactions, w.engagementRate]),
    },
    {
      title: "Posts",
      headers: [
        "Published",
        "Client",
        "Title",
        "Type",
        "Reach",
        "Views",
        "Likes",
        "Comments",
        "Shares",
        "Saves",
        "Engagement rate %",
        "Link",
      ],
      rows: topPosts.map((p) => [
        p.publishedAt ? p.publishedAt.slice(0, 10) : "",
        p.clientName,
        p.title || (p.caption ? p.caption.slice(0, 80) : ""),
        p.mediaType,
        p.reach,
        p.views,
        p.likes,
        p.comments,
        p.shares,
        p.saves,
        p.engagementRate,
        p.permalink,
      ]),
    },
    {
      title: "Format performance",
      headers: ["Format", "Posts", "Avg engagement rate %", "Avg reach", "Total interactions"],
      rows: formats.map((c) => [
        c.label,
        c.posts,
        c.avgEngagementRate,
        c.avgReach,
        c.totalInteractions,
      ]),
    },
  ];

  // Only meaningful across several accounts; with one client selected it would
  // repeat the summary block above.
  if (!filters.clientId && clientRows.length > 1) {
    sections.push({
      title: "By client",
      headers: [
        "Client",
        "Instagram",
        "Followers",
        "Follower growth",
        "Reach",
        "Views",
        "Interactions",
        "Engagement rate %",
        "Posts",
      ],
      rows: clientRows.map((c) => [
        c.clientName,
        c.igUsername ? `@${c.igUsername}` : "",
        c.followers,
        c.followerGrowth,
        c.reach,
        c.views,
        c.interactions,
        c.engagementRate,
        c.posts,
      ]),
    });
  }

  return csvResponse(
    toCsvWorkbook(sections),
    csvFilename(["analytics", client?.company_name, filters.from, "to", filters.to])
  );
}
