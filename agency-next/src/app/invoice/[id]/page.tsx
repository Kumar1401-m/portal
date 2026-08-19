import { notFound } from "next/navigation";
import { getSession, requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { getInvoiceDocument } from "@/lib/payments";
import { getSettings } from "@/lib/settings";
import { verifyDocToken } from "@/lib/doc-link";
import { PrintButton } from "@/components/print-button";
import { Paper, Section, INK } from "@/components/document";

export const dynamic = "force-dynamic";

/**
 * One invoice, on paper.
 *
 * Clients could already see an invoice in the portal, as a row in a table with
 * a Pay button. That is enough to pay from and no use at all to an accountant,
 * who needs a document with a number, a date, the line items and who issued
 * it — which is what "can you send the invoice" actually means when a client
 * asks for it, and why it used to be typed out by hand.
 *
 * Three ways in, in order of how often they happen: the client following the
 * signed link from their WhatsApp group, the client already signed into their
 * portal, and staff opening it from Payments.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = await getInvoiceDocument(Number(id)).catch(() => null);
  // The tab title becomes the suggested filename in the save dialog.
  return { title: inv ? `Invoice ${inv.invoice_no} — ${inv.company_name}` : "Invoice" };
}

const money = (n: number, currency = "INR") =>
  `${currency === "INR" ? "₹" : `${currency} `}${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function longDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function InvoiceDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ k?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) notFound();

  const [inv, settings] = await Promise.all([getInvoiceDocument(invoiceId), getSettings()]);
  if (!inv) notFound();

  /*
   * The token is signed over the invoice number as well as the id, so a link
   * dies if the invoice is ever reissued under a new number — and a sequential
   * id in the URL is not on its own enough to read somebody else's invoice.
   */
  if (!verifyDocToken("invoice", inv.id, inv.invoice_no, sp.k ?? "")) {
    const session = await getSession();
    // The client whose invoice it is, signed into their own portal.
    const isOwner = session?.role === "client" && session.clientId === inv.client_id;
    if (!isOwner) {
      const user = await requireUser(ADMIN_OR_CRM_ROLES);
      if (!(await canAccessClient(user, inv.client_id))) notFound();
    }
  }

  const paid = inv.status === "paid";
  const subtotal = inv.lines.reduce((t, l) => t + l.qty * l.rate, 0);
  /*
   * Whatever the lines do not account for.
   *
   * The total is the authority — it is what the payment row was created for
   * and what the client is being asked to pay — but the lines are written
   * separately, and an invoice from before `line_items` existed falls back to
   * a single line for the amount, leaving the processing fee out of the
   * column. Without this, such an invoice prints a subtotal and a tax that do
   * not add up to its own total, which is the one thing a document about money
   * must never do.
   */
  const other = Math.round((inv.total - inv.tax - subtotal) * 100) / 100;

  return (
    <Paper
      agency={settings}
      kicker={paid ? "Receipt" : "Invoice"}
      title={inv.invoice_no}
      controls={
        <>
          <p className="text-sm text-neutral-600">
            Choose <b>Save as PDF</b> as the printer, then send the file to the client.
          </p>
          <PrintButton />
        </>
      }
    >
      <div className="mt-5 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: INK.faint }}>
            Billed to
          </p>
          <p className="mt-0.5 text-xl font-semibold tracking-tight">{inv.company_name}</p>
          {inv.contact_person ? <p className="text-sm">{inv.contact_person}</p> : null}
          <p className="text-sm" style={{ color: INK.soft }}>
            {[inv.phone, inv.email].filter(Boolean).join(" · ")}
          </p>
        </div>
        <dl className="shrink-0 space-y-1 text-right text-sm">
          <div className="flex justify-end gap-4">
            <dt style={{ color: INK.faint }}>Issued</dt>
            <dd className="w-28 tabular-nums">{longDate(inv.issue_date)}</dd>
          </div>
          <div className="flex justify-end gap-4">
            <dt style={{ color: INK.faint }}>Due</dt>
            <dd className="w-28 tabular-nums">{longDate(inv.due_date)}</dd>
          </div>
          {/* A paid invoice says so on its face. Sending somebody a document
              headed "Due" for money they have already paid is the complaint
              that follows. */}
          {paid ? (
            <div className="flex justify-end gap-4">
              <dt style={{ color: INK.faint }}>Paid</dt>
              <dd className="w-28 font-semibold tabular-nums" style={{ color: "#0d9488" }}>
                {longDate(inv.paid_at)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <Section title="Charges">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr
              className="border-b text-left text-[11px] uppercase tracking-wide"
              style={{ borderColor: "#d4d4d4", color: INK.faint }}
            >
              <th className="py-1.5 font-semibold">Description</th>
              <th className="w-16 py-1.5 text-right font-semibold">Qty</th>
              <th className="w-32 py-1.5 text-right font-semibold">Rate</th>
              <th className="w-32 py-1.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} className="border-b" style={{ borderColor: "#f5f5f5" }}>
                <td className="py-2 pr-3 align-top" style={{ color: INK.text }}>
                  {l.description || "Services"}
                </td>
                <td className="py-2 text-right align-top tabular-nums">{l.qty}</td>
                <td className="py-2 text-right align-top tabular-nums">
                  {money(l.rate, inv.currency)}
                </td>
                <td className="py-2 text-right align-top tabular-nums">
                  {money(l.qty * l.rate, inv.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} />
              <td className="py-1.5 text-right" style={{ color: INK.faint }}>
                Subtotal
              </td>
              <td className="py-1.5 text-right tabular-nums">{money(subtotal, inv.currency)}</td>
            </tr>
            {other !== 0 ? (
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right" style={{ color: INK.faint }}>
                  {other > 0 ? "Other charges" : "Adjustment"}
                </td>
                <td className="py-1.5 text-right tabular-nums">{money(other, inv.currency)}</td>
              </tr>
            ) : null}
            {inv.tax > 0 ? (
              <tr>
                <td colSpan={2} />
                <td className="py-1.5 text-right" style={{ color: INK.faint }}>
                  Tax
                </td>
                <td className="py-1.5 text-right tabular-nums">{money(inv.tax, inv.currency)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={2} />
              <td
                className="border-t py-2 text-right font-semibold"
                style={{ borderColor: "#d4d4d4", color: INK.text }}
              >
                {paid ? "Paid" : "Total due"}
              </td>
              <td
                className="border-t py-2 text-right text-lg font-semibold tabular-nums"
                style={{ borderColor: "#d4d4d4", color: INK.brand }}
              >
                {money(inv.total, inv.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Section>

      {inv.notes ? (
        <Section title="Notes">
          <p className="whitespace-pre-wrap">{inv.notes}</p>
        </Section>
      ) : null}

      <p className="mt-6 text-sm" style={{ color: INK.soft }}>
        {paid
          ? `Received with thanks${inv.method ? ` by ${inv.method}` : ""}. This is your receipt.`
          : "Please settle by the due date above. Any questions, just reply — happy to help."}
      </p>
    </Paper>
  );
}
