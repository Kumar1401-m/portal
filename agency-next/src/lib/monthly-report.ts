/**
 * The month, written up for the client, without anybody writing it up.
 *
 * Every agency owes a client a monthly report and every agency sends it late,
 * because it is an hour of copying numbers out of four dashboards into a
 * message — reach from Instagram, spend from Ads Manager, "how many did we
 * post" from memory. It is also the single thing a client most reliably reads.
 *
 * So the portal already holds all four, and this builds the message from
 * them: what was delivered, how it performed, what the audience did, what the
 * ads cost. On the 1st a scheduled job queues one per client through the same
 * WhatsApp outbox every other reminder goes out on — visible in the console,
 * cancellable before it sends, and never a second channel to maintain.
 *
 * A section with no data is left out rather than sent as zero. A client who
 * runs no ads should not receive "₹0 spent, 0 leads" every month, which reads
 * as a failed month rather than a service they never bought.
 */
import "server-only";
import { query, queryOne, execute, hasTable } from "./db";
import { onTheFloor } from "./client-status";
import { groupForClient, queueMessage, nowUtc } from "./reminder-outbox";

const num = (v: unknown) => Number(v ?? 0);

export type ReportSection = {
  content: { planned: number; delivered: number; approved: number };
  posts: { count: number; reach: number; interactions: number; topLink: string | null } | null;
  audience: { platform: string; followers: number; gained: number | null }[];
  ads: { spend: number; currency: string; impressions: number; leads: number } | null;
};

export type MonthlyReport = {
  clientId: number;
  client: string;
  month: string;
  monthLabel: string;
} & ReportSection;

/** "August 2026", from "2026-08". */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Gather one client's month.
 *
 * Each source is guarded on its own table existing, so a database that has
 * applied some of the schema and not the rest produces a shorter report
 * rather than an error — the content section is the one that always works,
 * and it is the one clients ask about.
 */
export async function buildMonthlyReport(clientId: number, month: string): Promise<MonthlyReport | null> {
  const client = await queryOne<{ id: number; company_name: string }>(
    "SELECT id, company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  const [hasInsights, hasAudience, hasAds] = await Promise.all([
    hasTable("post_insights"),
    hasTable("audience_snapshots"),
    hasTable("ad_insights"),
  ]);

  const content = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS planned,
            SUM(status IN ('posted','completed')) AS delivered,
            SUM(status IN ('approved','scheduled','posted','completed')) AS approved
       FROM deliverables WHERE client_id = ? AND month_key = ?`,
    [clientId, month]
  );

  /*
   * One row per post, not one per daily snapshot — `post_insights` records a
   * post again every day it is read, so without the join back on the newest
   * snapshot a client would be told their month reached eleven times what it
   * did. Same shape as `getPosts` in analytics.ts, and for the same reason.
   */
  const posts = hasInsights
    ? await queryOne<Record<string, unknown>>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(p.reach),0) AS reach,
                COALESCE(SUM(p.total_interactions),0) AS interactions,
                /* The best post by engagement rate, not by reach — see analytics.ts. */
                SUBSTRING_INDEX(GROUP_CONCAT(p.permalink ORDER BY p.engagement_rate DESC), ',', 1) AS top_link
           FROM post_insights p
           JOIN (SELECT media_id, MAX(snapshot_date) AS latest
                   FROM post_insights GROUP BY media_id) last
             ON last.media_id = p.media_id AND last.latest = p.snapshot_date
          WHERE p.client_id = ? AND DATE_FORMAT(p.published_at,'%Y-%m') = ?`,
        [clientId, month]
      )
    : null;

  /*
   * Followers at the end of the month against the end of the month before.
   *
   * Both read from the closing snapshot of their month, so a month still
   * running reports where it stands today rather than waiting for the 31st.
   */
  const audience = hasAudience
    ? await query<Record<string, unknown>>(
        `SELECT s.platform,
                s.followers,
                (SELECT p.followers FROM audience_snapshots p
                  WHERE p.client_id = s.client_id AND p.platform = s.platform
                    AND p.taken_on < CONCAT(?, '-01')
                  ORDER BY p.taken_on DESC LIMIT 1) AS before
           FROM audience_snapshots s
           JOIN (SELECT platform, MAX(taken_on) AS latest
                   FROM audience_snapshots
                  WHERE client_id = ? AND DATE_FORMAT(taken_on,'%Y-%m') <= ?
                  GROUP BY platform) t
             ON t.platform = s.platform AND t.latest = s.taken_on
          WHERE s.client_id = ?`,
        [month, clientId, month, clientId]
      ).catch(() => [])
    : [];

  const ads = hasAds
    ? await queryOne<Record<string, unknown>>(
        `SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(impressions),0) AS impressions,
                COALESCE(SUM(leads),0) AS leads, MAX(currency) AS currency
           FROM ad_insights WHERE client_id = ? AND DATE_FORMAT(date,'%Y-%m') = ?`,
        [clientId, month]
      )
    : null;

  return {
    clientId,
    client: client.company_name,
    month,
    monthLabel: monthName(month),
    content: {
      planned: num(content?.planned),
      delivered: num(content?.delivered),
      approved: num(content?.approved),
    },
    posts:
      posts && num(posts.count) > 0
        ? {
            count: num(posts.count),
            reach: num(posts.reach),
            interactions: num(posts.interactions),
            topLink: posts.top_link ? String(posts.top_link) : null,
          }
        : null,
    audience: audience.map((r) => ({
      platform: String(r.platform),
      followers: num(r.followers),
      gained: r.before === null || r.before === undefined ? null : num(r.followers) - num(r.before),
    })),
    ads: ads && num(ads.spend) > 0
      ? {
          spend: num(ads.spend),
          currency: String(ads.currency || "INR"),
          impressions: num(ads.impressions),
          leads: num(ads.leads),
        }
      : null,
  };
}

const inr = (n: number, currency = "INR") => {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
};

const count = (n: number) => new Intl.NumberFormat("en-IN").format(n);

/**
 * The message itself.
 *
 * Plain text with WhatsApp's own *bold*, because that is where it is read.
 * No greeting by first name — the group is the whole client team and half of
 * these go out at 9am on the 1st, so it reads as a statement rather than a
 * message pretending to have been typed by a person.
 */
export function renderReportText(r: MonthlyReport): string {
  const lines: string[] = [`*${r.client} — ${r.monthLabel}*`, ""];

  lines.push(`📦 *Content*`);
  lines.push(`${r.content.delivered} of ${r.content.planned} planned posts went live.`);
  if (r.content.approved > r.content.delivered) {
    lines.push(`${r.content.approved - r.content.delivered} approved and scheduled to go out.`);
  }

  if (r.posts) {
    lines.push("", `📊 *Performance*`);
    lines.push(
      `${count(r.posts.reach)} accounts reached across ${r.posts.count} post${r.posts.count === 1 ? "" : "s"}, with ${count(r.posts.interactions)} likes, comments, saves and shares.`
    );
    if (r.posts.topLink) lines.push(`Best performing post: ${r.posts.topLink}`);
  }

  const grew = r.audience.filter((a) => a.gained !== null);
  if (grew.length) {
    lines.push("", `👥 *Audience*`);
    for (const a of grew) {
      const name = a.platform === "instagram" ? "Instagram" : "Facebook";
      const sign = (a.gained ?? 0) >= 0 ? "+" : "";
      lines.push(`${name}: ${count(a.followers)} followers (${sign}${count(a.gained ?? 0)} this month)`);
    }
  }

  if (r.ads) {
    lines.push("", `📣 *Ads*`);
    const cpl = r.ads.leads ? inr(r.ads.spend / r.ads.leads, r.ads.currency) : null;
    lines.push(
      `${inr(r.ads.spend, r.ads.currency)} spent, ${count(r.ads.impressions)} impressions` +
        (r.ads.leads ? `, ${count(r.ads.leads)} leads at ${cpl} each.` : ".")
    );
  }

  lines.push("", "Happy to walk through any of this — just say the word. 🙏");
  return lines.join("\n");
}

/* ---------------------------- Sending it out ---------------------------- */

export type QueueSummary = {
  month: string;
  queued: number;
  skipped: { client: string; reason: string }[];
};

/** First and last day of a month, as the ledger stores them. */
const monthBounds = (month: string): { start: string; end: string } => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
};

/**
 * Claim this client's month, once.
 *
 * `scheduled_reports` was already in the schema with a unique key on
 * (client, period, period_start) — which is exactly the guarantee a monthly
 * job needs and the one thing an outbox cannot give it. Without a claim, the
 * job running twice on the 1st sends every client two reports, and there is no
 * way to tell from the outbox whether a row is a duplicate or a resend
 * somebody meant.
 *
 * Returns false when this month is already recorded. Returns true when the
 * ledger is missing entirely — a database without the table still gets its
 * reports, it just gets no protection from a second run.
 */
async function claimPeriod(clientId: number, month: string, summary: MonthlyReport): Promise<boolean> {
  if (!(await hasTable("scheduled_reports"))) return true;
  const { start, end } = monthBounds(month);
  try {
    const res = await execute(
      `INSERT IGNORE INTO scheduled_reports
         (client_id, period, period_start, period_end, status, summary_json)
       VALUES (?, 'monthly', ?, ?, 'pending', ?)`,
      [clientId, start, end, JSON.stringify(summary)]
    );
    return (res.affectedRows ?? 0) > 0;
  } catch {
    // A ledger that will not write must not stop the report going out.
    return true;
  }
}

/**
 * Note that a report actually reached the client.
 *
 * Only the send-by-hand path can say this: the batch hands its messages to the
 * outbox, which owns delivery from there and keeps its own sent/failed record
 * per message. Marking a queued report "sent" at the moment it was queued
 * would be the ledger claiming something it does not know.
 */
export async function markReportSent(clientId: number, month: string, sentTo: string): Promise<void> {
  if (!(await hasTable("scheduled_reports"))) return;
  const { start, end } = monthBounds(month);
  await execute(
    `INSERT INTO scheduled_reports (client_id, period, period_start, period_end, status, sent_to, sent_at)
     VALUES (?, 'monthly', ?, ?, 'sent', ?, NOW())
     ON DUPLICATE KEY UPDATE status = 'sent', sent_to = VALUES(sent_to), sent_at = NOW()`,
    [clientId, start, end, sentTo.slice(0, 190)]
  ).catch(() => undefined);
}

/**
 * Queue one report per client, for a month.
 *
 * Queued rather than sent, always. Everything here is generated, and a
 * generated message that reaches a client before a human has had the chance
 * to see it is the failure mode that ends a client relationship — the outbox
 * puts it in the Reminders console with a send time on it, where it can be
 * read and cancelled.
 *
 * A client with nothing to report is skipped rather than sent an empty month.
 */
export async function queueMonthlyReports(
  month: string,
  sendAt?: string,
  by?: { id: number; name: string }
): Promise<QueueSummary> {
  const clients = await query<{ id: number; company_name: string }>(
    `SELECT c.id, c.company_name FROM clients c
      WHERE ${onTheFloor()} AND COALESCE(c.is_personal,0) = 0
      ORDER BY c.company_name`
  );

  const out: QueueSummary = { month, queued: 0, skipped: [] };

  for (const c of clients) {
    const report = await buildMonthlyReport(c.id, month);
    if (!report) continue;

    if (!report.content.planned && !report.posts) {
      out.skipped.push({ client: c.company_name, reason: "nothing happened this month" });
      continue;
    }

    const group = await groupForClient(c.id);
    if (!group) {
      out.skipped.push({ client: c.company_name, reason: "no WhatsApp group linked" });
      continue;
    }

    // Claimed last, so a client skipped for any reason above can still be
    // picked up by a later run rather than being marked done for the month.
    if (!(await claimPeriod(c.id, month, report))) {
      out.skipped.push({ client: c.company_name, reason: "already queued for this month" });
      continue;
    }

    await queueMessage({
      kind: "monthly_report",
      clientId: c.id,
      groupId: group.groupId,
      groupLabel: group.label,
      body: renderReportText(report),
      sendAt: sendAt || nowUtc(),
      createdBy: by?.id ?? null,
      createdByName: by?.name ?? "Monthly report",
    });
    out.queued++;
  }

  return out;
}
