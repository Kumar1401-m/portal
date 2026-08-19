import { notFound } from "next/navigation";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { buildMonthlyReport } from "@/lib/monthly-report";
import { getDeliverables } from "@/lib/deliverables";
import { getSettings } from "@/lib/settings";
import { DONE_STATUSES } from "@/lib/constants";
import { thisMonthKey } from "@/lib/date-range";
import { verifyDocToken } from "@/lib/doc-link";
import { PrintButton } from "@/components/print-button";
import { Paper, Section, Stat, Donut, Legend, GrowthBars, toSlices, INK } from "@/components/document";

export const dynamic = "force-dynamic";

/**
 * The month as a document, for sending.
 *
 * The report already existed as a WhatsApp message and clients read it, but a
 * message is not a thing anybody keeps — at a review meeting or a renewal
 * conversation what gets opened is a file. So this is the same month laid out
 * on paper, and the PDF is made by the browser's own print dialog rather than
 * by a rendering service: no dependency, no fifty-megabyte serverless
 * chromium, and the fonts are the ones already on the page, which is what
 * keeps a Telugu client name from coming out as boxes.
 *
 * Two ways in. Staff open it from the reports page and are checked against the
 * client the usual way. A client opens it from the link in their WhatsApp
 * group, where the signed `k` in the URL is the permission — see `doc-link.ts`
 * for why a login wall on a link like this means the report goes unread.
 *
 * Same rule as the message it mirrors: a section with nothing in it is left
 * out, never sent as zero. A client who buys no ads should not receive
 * "₹0 spent", which reads as a failed month rather than a service they never
 * bought.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : thisMonthKey();
  const report = await buildMonthlyReport(Number(id), month).catch(() => null);
  // The tab title is what the browser offers as the filename in the save
  // dialog, so it is the report's name rather than the page's.
  return { title: report ? `${report.client} — ${report.monthLabel} report` : "Report" };
}

const count = (n: number) => n.toLocaleString("en-IN");
const inr = (n: number, currency = "INR") =>
  `${currency === "INR" ? "₹" : `${currency} `}${Math.round(n).toLocaleString("en-IN")}`;

/** dd-mm-yyyy, the way every other date in this portal is written. */
function shortDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export default async function ReportDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; k?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const clientId = Number(id);
  if (!Number.isInteger(clientId) || clientId <= 0) notFound();

  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : thisMonthKey();

  /*
   * The token is signed over the month as well as the client, so a link to
   * August cannot be edited into September — and it is checked against the
   * month AFTER validation, or a junk month would fall back to this one and
   * hand out a document the link was never signed for.
   */
  const viaLink = verifyDocToken("report", clientId, month, sp.k ?? "");
  if (!viaLink) {
    const user = await requireUser(ADMIN_OR_CRM_ROLES);
    if (!(await canAccessClient(user, clientId))) notFound();
  }

  const [report, settings, work] = await Promise.all([
    buildMonthlyReport(clientId, month),
    getSettings(),
    getDeliverables({ clientId, month }),
  ]);
  if (!report) notFound();

  // What was actually finished. The planned-but-not-delivered rows stay off
  // the client's copy — this is a record of the month, not a to-do list.
  const delivered = work.filter((d) => DONE_STATUSES.includes(d.status as never));
  const grew = report.audience.filter((a) => a.gained !== null);

  // The month's work, by kind. The one genuine part-to-whole on the page:
  // "what did our money go on" is the question the pie answers.
  const byKind = new Map<string, number>();
  for (const d of delivered) {
    const kind = d.content_category || d.video_type || "Other";
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const slices = toSlices(byKind);

  return (
    <Paper
      agency={settings}
      kicker="Monthly report"
      title={report.monthLabel}
      controls={
        <>
          <p className="text-sm text-neutral-600">
            Choose <b>Save as PDF</b> as the printer, then send the file to the client.
          </p>
          <PrintButton />
        </>
      }
    >
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">{report.client}</h1>
      <p className="mt-1 text-sm" style={{ color: INK.soft }}>
        Everything we made this month, and what it did.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Counted from the very rows listed further down, not from a second
            query. The two disagreed on the first draft — the headline said two
            and the table listed three, because "delivered" meant posted and the
            table meant finished. A document that contradicts itself in two
            places is the one a client reads closely. */}
        <Stat
          label="Delivered"
          value={count(delivered.length)}
          sub={`of ${count(report.content.planned)} planned`}
        />
        {report.posts ? (
          <Stat
            label="Accounts reached"
            value={count(report.posts.reach)}
            sub={`across ${report.posts.count} post${report.posts.count === 1 ? "" : "s"}`}
          />
        ) : null}
        {report.posts ? (
          <Stat
            label="Interactions"
            value={count(report.posts.interactions)}
            sub="likes, comments, saves, shares"
          />
        ) : null}
        {report.ads ? (
          <Stat
            label="Ad spend"
            value={inr(report.ads.spend, report.ads.currency)}
            sub={report.ads.leads ? `${count(report.ads.leads)} leads` : undefined}
          />
        ) : null}
      </div>

      {slices.length > 1 ? (
        <Section title="What the month went on">
          <div className="flex flex-wrap items-center gap-6">
            <Donut slices={slices} total={delivered.length} caption="pieces" />
            <Legend slices={slices} total={delivered.length} />
          </div>
        </Section>
      ) : null}

      {report.posts ? (
        <Section title="Performance">
          <p>
            {count(report.posts.reach)} accounts reached across {report.posts.count} post
            {report.posts.count === 1 ? "" : "s"}, with {count(report.posts.interactions)} likes,
            comments, saves and shares.
          </p>
          {report.posts.topLink ? (
            <p className="mt-1 break-all" style={{ color: INK.faint }}>
              Best performing post: {report.posts.topLink}
            </p>
          ) : null}
        </Section>
      ) : null}

      {grew.length ? (
        <Section title="Audience">
          <GrowthBars
            rows={grew.map((a) => ({
              platform: a.platform === "instagram" ? "Instagram" : "Facebook",
              followers: a.followers,
              gained: a.gained ?? 0,
            }))}
          />
        </Section>
      ) : null}

      {report.ads ? (
        <Section title="Ads">
          <p>
            {inr(report.ads.spend, report.ads.currency)} spent, {count(report.ads.impressions)}{" "}
            impressions
            {report.ads.leads
              ? `, ${count(report.ads.leads)} leads at ${inr(
                  report.ads.spend / report.ads.leads,
                  report.ads.currency
                )} each.`
              : "."}
          </p>
        </Section>
      ) : null}

      {delivered.length ? (
        <Section title={`What we made — ${delivered.length} piece${delivered.length === 1 ? "" : "s"}`}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr
                className="border-b text-left text-[11px] uppercase tracking-wide"
                style={{ borderColor: "#d4d4d4", color: INK.faint }}
              >
                <th className="w-8 py-1.5 font-semibold">#</th>
                <th className="py-1.5 font-semibold">Title</th>
                <th className="py-1.5 font-semibold">Type</th>
                <th className="py-1.5 font-semibold">Date</th>
                <th className="py-1.5 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {delivered.map((d, i) => (
                <tr key={d.id} className="break-inside-avoid border-b" style={{ borderColor: "#f5f5f5" }}>
                  <td className="py-1.5 align-top tabular-nums" style={{ color: INK.faint }}>
                    {i + 1}
                  </td>
                  <td className="py-1.5 pr-3 align-top">{d.title}</td>
                  <td className="py-1.5 pr-3 align-top" style={{ color: INK.soft }}>
                    {d.content_category || d.video_type || "—"}
                  </td>
                  <td className="py-1.5 pr-3 align-top tabular-nums" style={{ color: INK.soft }}>
                    {shortDate(d.due_date)}
                  </td>
                  {/* Not `contentStatusLabel` — it folds approved, scheduled,
                      posted and completed into one word, so on a list of
                      finished work every row would read "Approved" and the
                      column would say nothing. The distinction a client
                      actually asks about is whether it went out. */}
                  <td className="py-1.5 text-right align-top" style={{ color: INK.soft }}>
                    {d.status === "posted" || d.status === "completed" ? "Published" : "Delivered"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      <p className="mt-6 text-sm" style={{ color: INK.soft }}>
        Happy to walk through any of this — just say the word.
      </p>
    </Paper>
  );
}
