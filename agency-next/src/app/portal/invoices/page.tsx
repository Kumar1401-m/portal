import { FileText, CheckCircle2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPortalInvoices, getPortalClientInfo } from "@/lib/portal";
import { isRazorpayEnabled } from "@/lib/razorpay";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { PayButton } from "./pay-button";
import { money, label, fmtDate } from "@/lib/utils";

export const metadata = { title: "Invoices · NVK Media" };
export const dynamic = "force-dynamic";

export default async function PortalInvoicesPage() {
  const user = await requireUser(["client"]);
  const [invoices, client, canPayOnline] = await Promise.all([
    user.clientId ? getPortalInvoices(user.clientId) : Promise.resolve([]),
    user.clientId ? getPortalClientInfo(user.clientId) : Promise.resolve(null),
    isRazorpayEnabled(),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <FileText className="h-6 w-6 text-primary" /> Invoices
      </h1>

      <Card className="overflow-hidden">
        {invoices.length === 0 ? (
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No invoices yet.
          </CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Invoice #</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Amount</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </THead>
            <TBody>
              {invoices.map((inv) => (
                <TR key={inv.id}>
                  <TD className="font-medium">{inv.invoice_no}</TD>
                  <TD className="text-muted-foreground">{fmtDate(inv.issue_date)}</TD>
                  <TD className="text-muted-foreground">{fmtDate(inv.due_date)}</TD>
                  <TD className="tabular-nums">{money(inv.total)}</TD>
                  <TD>
                    <Badge tone={statusTone(inv.status)}>{label(inv.status)}</Badge>
                  </TD>
                  <TD className="text-right">
                    {inv.status === "paid" ? (
                      <span className="inline-flex items-center gap-1 text-sm text-success">
                        <CheckCircle2 className="h-4 w-4" /> Paid
                      </span>
                    ) : canPayOnline && inv.pending_payment_id ? (
                      <PayButton
                        invoiceId={inv.id}
                        invoiceNo={inv.invoice_no}
                        companyName={client?.company_name || "Agency"}
                        contactEmail={client?.email}
                      />
                    ) : (
                      <span className="text-sm text-muted-foreground">Pending</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {!canPayOnline ? (
        <p className="text-center text-xs text-muted-foreground">
          Online payment is coming soon — for now, please settle via your usual method.
        </p>
      ) : null}
    </div>
  );
}
