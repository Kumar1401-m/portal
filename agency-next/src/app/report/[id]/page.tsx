import { notFound } from "next/navigation";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { buildMonthlyReport } from "@/lib/monthly-report";
import { getDeliverables } from "@/lib/deliverables";
import { getSettings } from "@/lib/settings";
import { DONE_STATUSES } from "@/lib/constants";
import { thisMonthKey } from "@/lib/date-range";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * The month as a document, for sending.
 *
 * The report already existed as a WhatsApp message and clients read it, but a
 * message is not a thing anybody keeps — at a review meeting or a renewal
 * conversation what gets opened is a file. So this is the same month, laid out
 * on paper, and the PDF is made by the browser's own print dialog rather than
 * by a rendering service: no dependency, no fifty-megabyte serverless
 * chromium, and the fonts are the ones already on the page, which is what
 * keeps a Telugu client name from coming out as boxes.
 *
 * Deliberately single-theme. A document that will be printed or forwarded is
 * white paper with black text whatever the person making it has their portal
 * set to, so this page uses fixed colours rather than the app's tokens.
 *
 * Same rule as the message it mirrors: a section with nothing in it is left
 * out, never sent as zero. A client who buys no ads should not receive
 * "₹0 spent" every month, which reads as a failed month rather than a service
 * they never bought.
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums text-neutral-900">{value}</p>
      {sub ? <p className="text-xs text-neutral-500">{sub}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 break-inside-avoid">
      <h2 className="border-b border-neutral-200 pb-1 text-sm font-semibold uppercase tracking-wide text-[#ea580c]">
        {title}
      </h2>
      <div className="mt-2 text-sm leading-relaxed text-neutral-700">{children}</div>
    </section>
  );
}

export default async function ReportDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const clientId = Number(id);
  if (!Number.isInteger(clientId) || clientId <= 0) notFound();
  if (!(await canAccessClient(user, clientId))) notFound();

  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : thisMonthKey();

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

  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      {/* Print rules, kept on the page they serve rather than in the app's
          shared stylesheet — nothing else in the portal is printed. */}
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          html, body { background: #fff !important; }
          /* Backgrounds and the brand colour are the document, not decoration,
             so they must survive the browser's default "don't print colour". */
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="mx-auto mb-3 flex max-w-[820px] items-center justify-between gap-3 px-4 print:hidden">
        <p className="text-sm text-neutral-600">
          Choose <b>Save as PDF</b> as the printer, then send the file to the client.
        </p>
        <PrintButton />
      </div>

      <article className="mx-auto max-w-[820px] bg-white p-10 text-neutral-900 shadow-sm print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-[#ea580c] pb-4">
          <div className="min-w-0">
            {settings.company_logo_url ? (
              /* A plain <img>, not next/image: this page is printed, and the
                 optimiser's lazy loading is one more thing between the logo
                 and the paper. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={settings.company_logo_url}
                alt={settings.company_name}
                className="mb-2 h-10 w-auto object-contain"
              />
            ) : (
              <p className="text-xl font-semibold tracking-tight">{settings.company_name}</p>
            )}
            <p className="text-xs text-neutral-500">
              {[settings.contact_number, settings.company_email].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
              Monthly report
            </p>
            <p className="text-lg font-semibold text-[#ea580c]">{report.monthLabel}</p>
          </div>
        </header>

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{report.client}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Everything we made this month, and what it did.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/* Counted from the very rows listed further down, not from a second
              query. The two disagreed on the first draft — the headline said
              two and the table listed three, because "delivered" meant posted
              and the table meant finished. A document that contradicts itself
              in two places is the one a client reads closely. */}
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

        {report.posts ? (
          <Section title="Performance">
            <p>
              {count(report.posts.reach)} accounts reached across {report.posts.count} post
              {report.posts.count === 1 ? "" : "s"}, with {count(report.posts.interactions)} likes,
              comments, saves and shares.
            </p>
            {report.posts.topLink ? (
              <p className="mt-1 break-all text-neutral-500">
                Best performing post: {report.posts.topLink}
              </p>
            ) : null}
          </Section>
        ) : null}

        {grew.length ? (
          <Section title="Audience">
            <ul className="space-y-1">
              {grew.map((a) => (
                <li key={a.platform}>
                  {a.platform === "instagram" ? "Instagram" : "Facebook"}:{" "}
                  <b className="tabular-nums">{count(a.followers)}</b> followers (
                  {(a.gained ?? 0) >= 0 ? "+" : ""}
                  {count(a.gained ?? 0)} this month)
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {report.ads ? (
          <Section title="Ads">
            <p>
              {inr(report.ads.spend, report.ads.currency)} spent,{" "}
              {count(report.ads.impressions)} impressions
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
                <tr className="border-b border-neutral-300 text-left text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="w-8 py-1.5 font-semibold">#</th>
                  <th className="py-1.5 font-semibold">Title</th>
                  <th className="py-1.5 font-semibold">Type</th>
                  <th className="py-1.5 font-semibold">Date</th>
                  <th className="py-1.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {delivered.map((d, i) => (
                  <tr key={d.id} className="break-inside-avoid border-b border-neutral-100">
                    <td className="py-1.5 align-top tabular-nums text-neutral-400">{i + 1}</td>
                    <td className="py-1.5 align-top pr-3">{d.title}</td>
                    <td className="py-1.5 align-top pr-3 text-neutral-600">
                      {d.content_category || d.video_type || "—"}
                    </td>
                    <td className="py-1.5 align-top pr-3 tabular-nums text-neutral-600">
                      {shortDate(d.due_date)}
                    </td>
                    {/* Not `contentStatusLabel` — it folds approved, scheduled,
                        posted and completed into one word, so on a list of
                        finished work every row would read "Approved" and the
                        column would say nothing. The distinction a client
                        actually asks about is whether it went out. */}
                    <td className="py-1.5 align-top text-right text-neutral-600">
                      {d.status === "posted" || d.status === "completed"
                        ? "Published"
                        : "Delivered"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}

        <footer className="mt-8 flex items-end justify-between gap-4 border-t border-neutral-200 pt-3 text-xs text-neutral-500">
          <p>
            Happy to walk through any of this — just say the word.
            {settings.business_address ? (
              <>
                <br />
                {settings.business_address}
              </>
            ) : null}
          </p>
          <p className="shrink-0 text-right">{settings.powered_by}</p>
        </footer>
      </article>
    </div>
  );
}
