import Link from "next/link";
import { Users, Plus } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getClients } from "@/lib/queries";
import { crmClientIds } from "@/lib/crm";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { label, fmtDate } from "@/lib/utils";

export const metadata = { title: "Clients · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const clientIds = await crmClientIds(user);
  const clients = await getClients(clientIds);
  const active = clients.filter((c) => c.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Users className="h-6 w-6 text-primary" />
            Clients
          </h1>
          <p className="text-sm text-muted-foreground">
            {clients.length} total · {active} active
          </p>
        </div>
        {user.role !== "crm" ? (
          <Link href="/clients/new" className={buttonClasses()}>
            <Plus className="h-4 w-4" /> New client
          </Link>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {clients.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No clients yet.
          </p>
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Package</th>
                <th className="text-center">Monthly</th>
                <th>Renewal</th>
              </tr>
            </THead>
            <TBody>
              {clients.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link
                      href={`/clients/${c.id}`}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {c.company_name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{c.email || "—"}</div>
                  </TD>
                  <TD>
                    <div>{c.contact_person || "—"}</div>
                    <div className="text-xs text-muted-foreground">{c.phone || ""}</div>
                  </TD>
                  <TD>
                    <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
                  </TD>
                  <TD>{c.monthly_package || "—"}</TD>
                  <TD className="text-center tabular-nums">{c.monthly_deliverables || "—"}</TD>
                  <TD className="text-muted-foreground">{fmtDate(c.renewal_date)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
