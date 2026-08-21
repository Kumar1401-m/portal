import Link from "next/link";
import {
  BarChart3,
  Eye,
  Heart,
  Users,
  Bookmark,
  TriangleAlert,
  ExternalLink,
  CalendarClock,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import {
  getPosts,
  byClient,
  audienceByPlatform,
  insightsReady,
  lastInsightSync,
  engagementRate,
  interactions,
  rank,
  slots,
  sum,
  formatLabel,
  hourLabel,
  WEEKDAYS,
  type PostRow,
} from "@/lib/analytics";
import { resolveRange } from "@/lib/date-range";
import { getAudience } from "@/lib/audience";
import { AudienceTile } from "@/components/admin/audience-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { RangePicker } from "@/components/admin/range-picker";
import { ClientFilter, SyncInsights } from "./controls";
import { fmtDate } from "@/lib/utils";
import { prettyLocal } from "@/lib/posting";

export const metadata = { title: "Analytics · NVK Hub" };
export const dynamic = "force-dynamic";

const count = (n: number) => new Intl.NumberFormat("en-IN").format(n);
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

/**
 * Three formats, three fixed hues, assigned by identity and never by rank —
 * a filter that drops carousels must not repaint reels.
 *
 * Both columns are validated against this portal's own card surfaces rather
 * than assumed: the light row passes with a contrast warning and the dark row
 * sits in the CVD floor band, and both are answered the same way — every
 * segment carries its own visible label, so the colour is never the only
 * thing telling them apart.
 */
const FORMAT_HUES: Record<string, string> = {
  Reel: "bg-[#f97316] dark:bg-[#ea580c]",
  Post: "bg-[#0ea5e9] dark:bg-[#0284c7]",
  Carousel: "bg-[#a855f7] dark:bg-[#9333ea]",
};
const OTHER_HUE = "bg-muted-foreground/60";

/** A horizontal magnitude bar. Rounded at the data end, flat on the baseline. */
function Bar({ share, tone = "bg-primary" }: { share: number; tone?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
      <div
        className={`h-full rounded-r-[4px] ${tone}`}
        style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; client?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const sp = await searchParams;

  if (!(await insightsReady())) {
    return (
      <div className="space-y-5">
        <Header />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <TriangleAlert className="h-8 w-8 text-warning" />
            <p className="font-medium">One step to switch this on</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Analytics reads each published post&apos;s reach and engagement back from Instagram
              into a table this database doesn&apos;t have yet. Open{" "}
              <span className="font-medium text-foreground">Settings → Database</span> and apply the
              pending changes.
            </p>
            <Link href="/settings" className="text-sm text-primary hover:underline">
              Go to Settings → Database
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scope = await crmClientIds(user);
  const clients = await getClientsMini(scope);

  const wanted = Number(sp.client);
  // A client id that isn't in this user's own list is ignored rather than
  // refused — a crm following a stale link lands on their own board.
  const clientId =
    Number.isInteger(wanted) && clients.some((c) => c.id === wanted) ? wanted : null;

  const range = resolveRange(sp.range ?? new Date().toISOString().slice(0, 7));

  /*
   * Take today's follower reading before the board is read back.
   *
   * The Followers card reads `audience_snapshots`, and the only thing that
   * has ever written to it is opening Ad Management for that client. So a
   * client nobody had visited there showed a dash for ever — on the page whose
   * whole subject is their numbers, beside a reach figure read live from the
   * same account. Same call the ads page makes, on the same terms: one client
   * at a time, best-effort, and the page renders whether or not Meta answers.
   *
   * Only when a client is picked. The all-clients view would be one Graph
   * request per client on every page view, to fill in a total that is already
   * the sum of everyone who has been looked at.
   */
  const audienceNow = clientId ? await getAudience(clientId).catch(() => null) : null;

  const [posts, audience, syncedAt] = await Promise.all([
    getPosts(range.from, range.to, { clientId, clientIds: scope }),
    audienceByPlatform(),
    lastInsightSync(),
  ]);

  /*
   * Instagram, for everything measured against a post.
   *
   * Reach, engagement and the posts themselves are Instagram's on this board,
   * so the follower figure beside them has to be Instagram's too. The other
   * platforms get their own card rather than being folded into this number.
   */
  const followers = new Map(
    [...audience].flatMap(([id, p]) => (p.instagram ? [[id, p.instagram] as const] : []))
  );

  const totals = sum(posts);
  const rate = engagementRate(totals);
  const rows = byClient(posts);
  for (const r of rows) {
    const f = followers.get(r.client_id);
    r.followers = f?.followers ?? null;
    r.growth = f?.growth ?? null;
  }

  // Followers shown in the header follow the scope: one client's own count,
  // or the total across everybody this user can see.
  const scopedFollowers = clientId
    ? (followers.get(clientId)?.followers ?? null)
    : [...followers.entries()]
        .filter(([id]) => clients.some((c) => c.id === id))
        .reduce((t, [, v]) => t + v.followers, 0);
  const scopedGrowth = clientId
    ? (followers.get(clientId)?.growth ?? null)
    : [...followers.entries()]
        .filter(([id]) => clients.some((c) => c.id === id))
        .reduce<number | null>((t, [, v]) => (v.growth === null ? t : (t ?? 0) + v.growth), null);


  const top = rank(posts);
  const best = slots(posts, "weekday");
  const bestHours = slots(posts, "hour");
  const formats = formatSplit(posts);
  const maxReach = Math.max(1, ...rows.map((r) => r.totals.reach));

  return (
    <div className="space-y-5">
      <Header>
        <ClientFilter clients={clients} current={clientId} range={range.key} />
        <RangePicker
          current={range.key}
          basePath={clientId ? `/analytics?client=${clientId}` : "/analytics"}
        />
        <SyncInsights clientId={clientId} />
      </Header>

      {syncedAt ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          Last read from Instagram {prettyLocal(syncedAt)}.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Accounts reached"
          value={count(totals.reach)}
          hint={`${totals.posts} post${totals.posts === 1 ? "" : "s"} in this period`}
          icon={Eye}
          tone="sky"
        />
        <StatCard
          title="Engagement rate"
          value={pct(rate)}
          hint={`${count(interactions(totals))} likes, comments, saves and shares`}
          icon={Heart}
          tone="rose"
        />
        <StatCard
          title="Followers"
          value={scopedFollowers === null ? "—" : count(scopedFollowers)}
          hint={
            scopedGrowth === null
              ? "No earlier month to compare against yet"
              : `${scopedGrowth >= 0 ? "+" : ""}${count(scopedGrowth)} since last month`
          }
          icon={Users}
          tone="orange"
        />
        <StatCard
          title="Saves and shares"
          value={count(totals.saves + totals.shares)}
          hint="The two that mean somebody kept it"
          icon={Bookmark}
          tone="emerald"
        />
      </div>

      {/*
        * Where the audience actually is, one platform at a time.
        *
        * The tile above it says "Followers" and means Instagram, because
        * every post on this board is an Instagram post. That is the right
        * number to put beside a reach figure and the wrong answer to "how big
        * are we?" — a client is on three platforms and the sum of the three is
        * a number true of no account anybody can open. Same component the ads
        * page uses, for the same reason it gives: one scale each, honestly.
        *
        * Only for a single client. Across the roster these would be three
        * totals of unrelated accounts, which is the chart this component was
        * written to avoid.
        */}
      {audienceNow ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          {audienceNow.instagram ? (
            <AudienceTile
              platform="instagram"
              label="Instagram followers"
              handle={audienceNow.instagram.username ? `@${audienceNow.instagram.username}` : null}
              followers={audienceNow.instagram.followers}
              history={audienceNow.instagram.history}
              change={audienceNow.instagram.change}
            />
          ) : null}
          {audienceNow.facebook ? (
            <AudienceTile
              platform="facebook"
              label="Facebook followers"
              handle={audienceNow.facebook.name}
              followers={audienceNow.facebook.followers}
              history={audienceNow.facebook.history}
              change={audienceNow.facebook.change}
            />
          ) : null}
          {audienceNow.youtube ? (
            <AudienceTile
              platform="youtube"
              label="YouTube subscribers"
              handle={null}
              followers={audienceNow.youtube.followers}
              history={audienceNow.youtube.history}
              change={audienceNow.youtube.change}
            />
          ) : null}
        </div>
      ) : null}

      {!posts.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Nothing to report for this period yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Press <span className="font-medium text-foreground">Refresh</span> to read the
              published posts back from Instagram. A client needs their Instagram account id and a
              working access token on their page for this to work.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Magnitude, one bar per client — only meaningful across more than one. */}
      {!clientId && rows.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reach by client</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5 pb-6">
            {rows.map((r) => (
              <div key={r.client_id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <Link
                    href={`/analytics?client=${r.client_id}&range=${range.key}`}
                    className="truncate font-medium hover:text-primary hover:underline"
                  >
                    {r.company_name}
                  </Link>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {count(r.totals.reach)} reached · {pct(r.rate)} engaged · {r.totals.posts} post
                    {r.totals.posts === 1 ? "" : "s"}
                  </span>
                </div>
                <Bar share={r.totals.reach / maxReach} />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {formats.length ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What performs, by format</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3.5 pb-6">
              {formats.map((f) => (
                <div key={f.label} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">
                      {f.label}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        ×{f.posts}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {count(f.avgReach)} avg reach · {pct(f.rate)} engaged
                    </span>
                  </div>
                  <Bar
                    share={f.avgReach / Math.max(1, ...formats.map((x) => x.avgReach))}
                    tone={FORMAT_HUES[f.label] ?? OTHER_HUE}
                  />
                </div>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">
                Average reach per post, so a format posted twice is compared fairly with one posted
                twenty times.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {best.length ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="h-4 w-4 text-muted-foreground" /> When to post
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pb-6 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Best days</p>
                <ul className="mt-2 space-y-1.5">
                  {best.slice(0, 3).map((s) => (
                    <li key={s.key} className="flex justify-between gap-3">
                      <span className="font-medium">{WEEKDAYS[Number(s.key)]}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {pct(s.avgEngagement)} engaged · {count(s.avgReach)} reach · {s.posts} posts
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {bestHours.length ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Best times</p>
                  <ul className="mt-2 space-y-1.5">
                    {bestHours.slice(0, 3).map((s) => (
                      <li key={s.key} className="flex justify-between gap-3">
                        <span className="font-medium">{hourLabel(s.key)}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {pct(s.avgEngagement)} engaged · {s.posts} posts
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Only slots with at least two posts behind them. One good Tuesday is not a pattern.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {top.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Best performing posts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pb-6">
            {top.map((p) => (
              <div
                key={p.media_id}
                className="flex items-start justify-between gap-4 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {p.caption?.split("\n")[0]?.slice(0, 90) || "No caption"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatLabel(p.media_type)} · {fmtDate(p.posted_at)}
                    {clientId ? null : ` · ${p.company_name ?? ""}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
                  <span title="Accounts reached">{count(p.reach)} reached</span>
                  <span className="font-medium text-foreground" title="Engagement rate">
                    {pct(engagementRate(p))}
                  </span>
                  {p.permalink ? (
                    <a
                      href={p.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                      aria-label="Open on Instagram"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              Ranked by engagement rate, not by reach — and posts seen by fewer than 50 accounts are
              left out, because four likes on eleven views is not a 40% month.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3 className="h-6 w-6 text-primary" /> Analytics
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What the work did once it was published — read from Instagram, not typed in.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

type FormatRow = { label: string; posts: number; avgReach: number; rate: number | null };

/** Average reach and engagement per format — reels against posts against carousels. */
function formatSplit(posts: PostRow[]): FormatRow[] {
  const map = new Map<string, PostRow[]>();
  for (const p of posts) {
    const key = formatLabel(p.media_type);
    map.set(key, [...(map.get(key) ?? []), p]);
  }
  return [...map.entries()]
    .map(([label, group]) => {
      const t = sum(group);
      return {
        label,
        posts: group.length,
        avgReach: Math.round(t.reach / group.length),
        rate: engagementRate(t),
      };
    })
    .sort((a, b) => b.avgReach - a.avgReach);
}
