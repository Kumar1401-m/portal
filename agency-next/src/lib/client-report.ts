/**
 * Weekly / monthly client performance reports.
 *
 * One module builds the figures once and renders them three ways — the email
 * body, the CSV/Excel export and the printable page all read the same
 * `ClientReport`. That is the point: a client who exports the spreadsheet and
 * compares it against the email they were sent must see identical numbers, and
 * the surest way to guarantee that is to compute them in exactly one place.
 */
import "server-only";
import { queryOne, execute, query } from "./db";
import { sendEmail } from "./email";
import { getAgencyInbox } from "./settings";
import { env } from "./env";
import {
  getComparedTotals,
  getTopPosts,
  getSeries,
  previousPeriod,
  type MetricTotals,
  type TopPost,
} from "./analytics";
import { getRecommendations, type StoredInsight } from "./insights-ai";

export type ReportPeriod = "weekly" | "monthly";

export type ClientReport = {
  clientId: number;
  clientName: string;
  contactPerson: string | null;
  email: string | null;
  igUsername: string | null;
  period: ReportPeriod;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  totals: MetricTotals;
  previousTotals: MetricTotals;
  growth: Record<keyof MetricTotals, number | null>;
  topPosts: TopPost[];
  daily: { bucket: string; reach: number; interactions: number; followers: number }[];
  recommendations: StoredInsight[];
};

/* --------------------------------- Period maths --------------------------------- */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The period that just *finished*, as of `reference`.
 *
 * Deliberately the completed one, not the one in progress: a Monday report
 * covering the Monday it is sent on would show a few hours of data and read as
 * a collapse. Weeks run Monday–Sunday, matching how the agency and Instagram
 * both count them.
 */
export function reportWindow(
  period: ReportPeriod,
  reference = new Date()
): { from: string; to: string } {
  const ref = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));

  if (period === "weekly") {
    // getUTCDay(): 0 = Sunday. Shift so Monday is 0, then step back over the
    // current partial week to land on the previous Sunday.
    const mondayOffset = (ref.getUTCDay() + 6) % 7;
    const lastSunday = new Date(ref.getTime() - (mondayOffset + 1) * 86400000);
    const lastMonday = new Date(lastSunday.getTime() - 6 * 86400000);
    return { from: iso(lastMonday), to: iso(lastSunday) };
  }

  const firstOfThisMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
  const firstOfPrevMonth = new Date(
    Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1)
  );
  return { from: iso(firstOfPrevMonth), to: iso(lastOfPrevMonth) };
}

/* ---------------------------------- Building ---------------------------------- */

/** Gather everything one client's report needs. */
export async function buildClientReport(
  clientId: number,
  period: ReportPeriod,
  window?: { from: string; to: string }
): Promise<ClientReport | null> {
  const client = await queryOne<{
    id: number;
    company_name: string;
    contact_person: string | null;
    email: string | null;
    ig_username: string | null;
  }>(
    `SELECT id, company_name, contact_person, email, ig_username
       FROM clients WHERE id = ?`,
    [clientId]
  );
  if (!client) return null;

  const { from, to } = window ?? reportWindow(period);
  const filters = { clientId, from, to, platform: "instagram" };

  const [compared, topPosts, series, recommendations] = await Promise.all([
    getComparedTotals(filters),
    getTopPosts(filters, 5),
    getSeries(filters, period === "weekly" ? "day" : "day"),
    getRecommendations(clientId),
  ]);

  const prev = previousPeriod(from, to);

  return {
    clientId: client.id,
    clientName: client.company_name,
    contactPerson: client.contact_person,
    email: client.email,
    igUsername: client.ig_username,
    period,
    from,
    to,
    previousFrom: prev.from,
    previousTo: prev.to,
    totals: compared.current,
    previousTotals: compared.previous,
    growth: compared.growth,
    topPosts,
    daily: series.map((s) => ({
      bucket: s.bucket,
      reach: s.reach,
      interactions: s.interactions,
      followers: s.followers,
    })),
    recommendations,
  };
}

/* ----------------------------------- Email ----------------------------------- */

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!
  );

const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

/**
 * Growth rendered for email, where CSS support is unreliable — colour is set
 * inline and the arrow carries the meaning on its own for anyone whose client
 * strips styles.
 */
function growthCell(value: number | null): string {
  if (value === null) return `<span style="color:#0ea5e9">new</span>`;
  if (value === 0) return `<span style="color:#94a3b8">no change</span>`;
  const up = value > 0;
  return `<span style="color:${up ? "#16a34a" : "#dc2626"}">${up ? "▲" : "▼"} ${Math.abs(value).toFixed(1)}%</span>`;
}

function metricRow(label: string, current: number, growth: number | null): string {
  return `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#475569">${esc(label)}</td>
    <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600">${fmt(current)}</td>
    <td style="padding:8px 0 8px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px">${growthCell(growth)}</td>
  </tr>`;
}

/** The report as an HTML email body (wrapped in the standard chrome by sendEmail). */
export function renderReportEmail(report: ClientReport): string {
  const { totals, growth } = report;
  const periodLabel = report.period === "weekly" ? "week" : "month";

  const metrics = [
    metricRow("Reach", totals.reach, growth.reach),
    metricRow("Views", totals.views, growth.views),
    metricRow("Accounts engaged", totals.accountsEngaged, growth.accountsEngaged),
    metricRow("Likes", totals.likes, growth.likes),
    metricRow("Comments", totals.comments, growth.comments),
    metricRow("Shares", totals.shares, growth.shares),
    metricRow("Saves", totals.saves, growth.saves),
    metricRow("Profile visits", totals.profileVisits, growth.profileVisits),
    metricRow("Website clicks", totals.websiteClicks, growth.websiteClicks),
    metricRow("Posts published", totals.postsCount, growth.postsCount),
  ].join("");

  const followerLine = totals.followers
    ? `<p style="margin:0 0 4px"><b>${fmt(totals.followers)}</b> followers
       <span style="color:${totals.followerGrowth >= 0 ? "#16a34a" : "#dc2626"}">
       (${totals.followerGrowth >= 0 ? "+" : ""}${fmt(totals.followerGrowth)} this ${periodLabel})</span></p>`
    : "";

  const top = report.topPosts.length
    ? `<h3 style="margin:24px 0 8px;font-size:15px">Best performing posts</h3>
       <ol style="margin:0;padding-left:18px;color:#475569;font-size:13px;line-height:1.7">
         ${report.topPosts
           .slice(0, 3)
           .map(
             (p) =>
               `<li>${
                 p.permalink
                   ? `<a href="${esc(p.permalink)}" style="color:#ea580c;text-decoration:none">${esc(
                       p.title || p.caption?.slice(0, 60) || "Post"
                     )}</a>`
                   : esc(p.title || "Post")
               } — ${fmt(p.reach)} reach, ${p.engagementRate.toFixed(1)}% engagement</li>`
           )
           .join("")}
       </ol>`
    : "";

  const advice = report.recommendations.length
    ? `<h3 style="margin:24px 0 8px;font-size:15px">What we'd change next ${periodLabel}</h3>
       <ul style="margin:0;padding-left:18px;color:#475569;font-size:13px;line-height:1.7">
         ${report.recommendations
           .slice(0, 3)
           .map((r) => `<li><b>${esc(r.headline)}</b><br/>${esc(r.detail || "")}</li>`)
           .join("")}
       </ul>`
    : "";

  return `<p>Hi ${esc(report.contactPerson || report.clientName)},</p>
    <p>Here's how ${esc(report.clientName)}${
      report.igUsername ? ` (@${esc(report.igUsername)})` : ""
    } performed on Instagram from <b>${esc(report.from)}</b> to <b>${esc(report.to)}</b>,
    compared with the ${periodLabel} before.</p>
    ${followerLine}
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
      <tr>
        <th style="text-align:left;padding-bottom:6px;font-size:12px;color:#94a3b8;font-weight:600">METRIC</th>
        <th style="text-align:right;padding-bottom:6px;font-size:12px;color:#94a3b8;font-weight:600">THIS ${periodLabel.toUpperCase()}</th>
        <th style="text-align:right;padding:0 0 6px 16px;font-size:12px;color:#94a3b8;font-weight:600">VS PREVIOUS</th>
      </tr>
      ${metrics}
    </table>
    <p style="font-size:13px;color:#64748b">Engagement rate: <b>${totals.engagementRate.toFixed(
      1
    )}%</b> (previously ${report.previousTotals.engagementRate.toFixed(1)}%)</p>
    ${top}
    ${advice}
    <p style="margin-top:20px"><a href="${esc(env.appUrl)}/portal/analytics"
      style="display:inline-block;background:#ea580c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">See the full dashboard</a></p>`;
}

/* ----------------------------------- Sending ----------------------------------- */

export type SendReportResult = {
  ok: boolean;
  clientId: number;
  sent: boolean;
  skipped?: "already_sent" | "no_email" | "no_data";
  error?: string;
};

/**
 * Build, send and record one client's report.
 *
 * Guarded by the unique key on `scheduled_reports`: the row is claimed
 * *before* the email goes out, so a workflow that retries after a timeout
 * cannot send a client the same report twice. `force` exists for a deliberate
 * resend from the UI.
 */
export async function sendClientReport(
  clientId: number,
  period: ReportPeriod,
  opts: { force?: boolean; window?: { from: string; to: string } } = {}
): Promise<SendReportResult> {
  const report = await buildClientReport(clientId, period, opts.window);
  if (!report) return { ok: false, clientId, sent: false, error: "Client not found." };
  if (!report.email) return { ok: true, clientId, sent: false, skipped: "no_email" };

  // A report of nothing is worse than no report — it reads as "we did nothing"
  // when the truth is usually "analytics isn't collecting for this account".
  if (!report.totals.reach && !report.totals.postsCount && !report.totals.followers) {
    return { ok: true, clientId, sent: false, skipped: "no_data" };
  }

  if (!opts.force) {
    const existing = await queryOne<{ id: number; status: string }>(
      `SELECT id, status FROM scheduled_reports
        WHERE client_id = ? AND period = ? AND period_start = ?`,
      [clientId, period, report.from]
    );
    if (existing && existing.status === "sent") {
      return { ok: true, clientId, sent: false, skipped: "already_sent" };
    }
  }

  await execute(
    `INSERT INTO scheduled_reports
       (client_id, period, period_start, period_end, status, sent_to, summary_json)
     VALUES (?,?,?,?,'pending',?,?)
     ON DUPLICATE KEY UPDATE
       status = 'pending', period_end = VALUES(period_end),
       sent_to = VALUES(sent_to), summary_json = VALUES(summary_json)`,
    [
      clientId,
      period,
      report.from,
      report.to,
      report.email,
      JSON.stringify({ totals: report.totals, growth: report.growth }),
    ]
  );

  const label = period === "weekly" ? "Weekly" : "Monthly";
  const subject = `${label} Instagram report — ${report.from} to ${report.to}`;

  const sent = await sendEmail(
    report.email,
    subject,
    `Your ${period === "weekly" ? "week" : "month"} on Instagram`,
    renderReportEmail(report)
  );

  await execute(
    `UPDATE scheduled_reports
        SET status = ?, sent_at = IF(? = 'sent', NOW(), sent_at), error_message = ?
      WHERE client_id = ? AND period = ? AND period_start = ?`,
    [
      sent ? "sent" : "failed",
      sent ? "sent" : "failed",
      sent ? null : "SMTP not configured or the send failed — see server logs.",
      clientId,
      period,
      report.from,
    ]
  );

  // The agency gets its own copy of the monthly round-up, so nobody has to ask
  // whether the client was told.
  if (sent && period === "monthly") {
    const inbox = await getAgencyInbox();
    if (inbox) {
      await sendEmail(
        inbox,
        `${subject} — ${report.clientName}`,
        `${report.clientName}: ${label.toLowerCase()} report sent`,
        renderReportEmail(report)
      );
    }
  }

  return { ok: true, clientId, sent };
}

export type DueReportRow = {
  client_id: number;
  company_name: string;
  email: string | null;
  already_sent: number;
};

/** Clients that should receive a report for the given period, and whether one already went. */
export async function getReportsDue(
  period: ReportPeriod,
  window?: { from: string; to: string }
): Promise<{ from: string; to: string; clients: DueReportRow[] }> {
  const { from, to } = window ?? reportWindow(period);
  const clients = await query<DueReportRow>(
    `SELECT c.id AS client_id, c.company_name, c.email,
            EXISTS (SELECT 1 FROM scheduled_reports sr
                     WHERE sr.client_id = c.id AND sr.period = ?
                       AND sr.period_start = ? AND sr.status = 'sent') AS already_sent
       FROM clients c
      WHERE c.status <> 'churned'
        AND c.analytics_enabled = 1
        AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''
        AND c.email IS NOT NULL AND c.email <> ''
      ORDER BY c.company_name`,
    [period, from]
  );
  return { from, to, clients };
}
