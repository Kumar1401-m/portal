import Link from "next/link";
import { CreditCard, Plus, IndianRupee, Clock, CheckCircle2, Wallet } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getPaymentsSummary, getInvoices, getPayments } from "@/lib/payments";
import { markPaid } from "./actions";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { Select } from "@/components/ui/select";
import { money, label, fmtDate } from "@/lib/utils";

export const metadata = { title: "Payments · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const user = await requireUser(ADMIN_ROLES);
  const canManage = user.role === "super_admin";
  const [summary, invoices, payments] = await Promise.all([
    getPaymentsSummary(),
    getInvoices(),
    getPayments(),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CreditCard className="h-6 w-6 text-primary" />
            Payments
          </h1>
          <p className="text-sm text-muted-foreground">Invoices, settlements &amp; history.</p>
        </div>
        {canManage ? (
          <Link href="/payments/new" className={buttonClasses()}>
            <Plus className="h-4 w-4" /> New invoice
          </Link>
        ) : null}
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Received this month" value={money(summary.month_received)} icon={IndianRupee} tone="emerald" />
        <StatCard
          title="Pending"
          value={money(summary.pending_amount)}
          hint={`${summary.pending_count} awaiting payment`}
          icon={Clock}
          tone="amber"
        />
        <StatCard title="Total received" value={money(summary.total_received)} icon={Wallet} tone="indigo" />
      </div>

      {/* Invoices */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {invoices.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <th>Invoice #</th>
                  <th>Client</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className="text-right">Action</th>
                </tr>
              </THead>
              <TBody>
                {invoices.map((inv) => (
                  <TR key={inv.id}>
                    <TD className="font-medium">{inv.invoice_no}</TD>
                    <TD>{inv.company_name}</TD>
                    <TD className="tabular-nums">{money(inv.total)}</TD>
                    <TD>
                      <Badge tone={statusTone(inv.status)}>{label(inv.status)}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">{fmtDate(inv.due_date)}</TD>
                    <TD>
                      <div className="flex items-center justify-end">
                        {inv.status !== "paid" && inv.pending_payment_id ? (
                          canManage ? (
                            <form action={markPaid} className="flex items-center gap-2">
                              <input type="hidden" name="payment_id" value={inv.pending_payment_id} />
                              <Select name="method" defaultValue="bank" className="h-8 w-24 text-xs">
                                <option value="bank">Bank</option>
                                <option value="upi">UPI</option>
                                <option value="cash">Cash</option>
                                <option value="other">Other</option>
                              </Select>
                              {/* Untick to record the payment without emailing
                                  a receipt to the client. */}
                              <label
                                className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
                                title="Email the receipt to the client and copy the agency inbox"
                              >
                                <input
                                  type="checkbox"
                                  name="send_email"
                                  defaultChecked
                                  className="h-4 w-4 rounded border-input accent-[var(--primary)]"
                                />
                                Email receipt
                              </label>
                              <Button type="submit" size="sm" variant="secondary">
                                Mark paid
                              </Button>
                            </form>
                          ) : (
                            <span className="text-sm text-muted-foreground">Pending</span>
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sm text-success">
                            <CheckCircle2 className="h-4 w-4" /> Paid
                          </span>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Payment history */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Payment history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {payments.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Invoice</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Status</th>
                </tr>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.id}>
                    <TD className="text-muted-foreground">{fmtDate(p.paid_at || p.created_at)}</TD>
                    <TD>{p.company_name}</TD>
                    <TD className="text-muted-foreground">{p.invoice_no || "—"}</TD>
                    <TD className="tabular-nums">{money(p.amount)}</TD>
                    <TD>{p.method ? label(p.method) : "—"}</TD>
                    <TD>
                      <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
