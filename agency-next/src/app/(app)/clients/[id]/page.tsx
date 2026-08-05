import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Pencil,
  Archive,
  Mail,
  Phone,
  Globe,
  Building2,
  IndianRupee,
} from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getClientDetail } from "@/lib/clients";
import { canAccessClient } from "@/lib/crm";
import { archiveClient } from "../actions";
import { PortalLogin } from "./portal-login";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge, ServiceChip } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { Table, THead, TBody, TR, TD } from "@/components/ui/table";
import { parseClientServices } from "@/lib/services";
import { money, label, fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getClientDetail(Number(id));
  return { title: c ? `${c.company_name} · Client` : "Client" };
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const { id } = await params;
  if (!(await canAccessClient(user, Number(id)))) notFound();
  const c = await getClientDetail(Number(id));
  if (!c) notFound();

  const ph = (c.placeholder_values && typeof c.placeholder_values === "object"
    ? c.placeholder_values
    : {}) as Record<string, unknown>;
  const cs = (c.caption_settings && typeof c.caption_settings === "object"
    ? c.caption_settings
    : {}) as Record<string, unknown>;
  const locBits = [ph.location, ph.country].filter(Boolean).join(", ");
  const services = parseClientServices(c.services);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-3">
        <Link href="/clients" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {c.company_name}
            <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {c.business_type || "—"}
            {c.contact_person ? ` · ${c.contact_person}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {user.role !== "crm" ? (
            <Link href={`/clients/${c.id}/edit`} className={buttonClasses({ variant: "outline", size: "sm" })}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          ) : null}
          {c.status !== "churned" && user.role === "super_admin" ? (
            <form action={archiveClient}>
              <input type="hidden" name="id" value={c.id} />
              <button
                type="submit"
                className={buttonClasses({ variant: "ghost", size: "sm" })}
              >
                <Archive className="h-4 w-4" /> Archive
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" /> {c.email || "—"}
              </p>
              <p className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" /> {c.phone || "—"}
              </p>
              {c.website ? (
                <a href={c.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-primary hover:underline">
                  <Globe className="h-4 w-4" /> Website ↗
                </a>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Services</CardTitle>
            </CardHeader>
            <CardContent>
              {services.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No services selected —{" "}
                  <Link href={`/clients/${c.id}/edit`} className="text-primary hover:underline">
                    set them
                  </Link>{" "}
                  to filter and report on this client.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {services.map((s) => (
                    <Link key={s} href={`/deliverables?service=${s}&client=${c.id}`}>
                      <ServiceChip service={s} />
                    </Link>
                  ))}
                </div>
              )}
              <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Instagram</span>
                  <Badge tone={c.ig_user_id ? "success" : "muted"}>
                    {c.ig_user_id ? "Connected" : "Not set up"}
                  </Badge>
                  {c.ig_username ? (
                    <a
                      href={`https://instagram.com/${c.ig_username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      @{c.ig_username}
                    </a>
                  ) : null}
                </div>
                {!c.ig_user_id ? (
                  <p className="text-xs text-muted-foreground">
                    Add the Instagram Business account id on the{" "}
                    <Link href={`/clients/${c.id}/edit`} className="text-primary hover:underline">
                      edit page
                    </Link>{" "}
                    to publish this client&apos;s approved Reels automatically.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Package</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Plan</span>
                <span>{c.monthly_package || "—"} ({label(c.payment_plan)})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span>{c.package_amount ? money(c.package_amount) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Monthly target</span>
                <span>{c.monthly_deliverables || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Renewal</span>
                <span>{fmtDate(c.renewal_date)}</span>
              </div>
              {locBits ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Caption locale</span>
                  <span>{locBits}{cs.language ? ` · ${String(cs.language)}` : ""}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <PortalLogin
            clientId={c.id}
            hasEmail={Boolean(c.email)}
            loginEmail={c.login_email}
            loginActive={c.login_active}
          />
        </div>

        {/* Right column */}
        <div className="space-y-6 lg:col-span-2">
          {/* Progress + payments */}
          <div className="grid gap-4 sm:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">This month</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.progress.total}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Completed</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.progress.completed}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Awaiting approval</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.progress.awaiting_approval}</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <IndianRupee className="h-3 w-3" /> Received
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{money(c.payments.total_received)}</p>
              {c.payments.pending_amount ? (
                <p className="text-xs text-muted-foreground">{money(c.payments.pending_amount)} pending</p>
              ) : null}
            </Card>
          </div>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="h-4 w-4 text-muted-foreground" /> Recent tasks
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {c.deliverables.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <th>Title</th>
                      <th>Service &amp; category</th>
                      <th>Status</th>
                      <th>Due</th>
                    </tr>
                  </THead>
                  <TBody>
                    {c.deliverables.map((d) => (
                      <TR key={d.id}>
                        <TD>
                          <Link href={`/deliverables/${d.id}`} className="font-medium hover:text-primary hover:underline">
                            {d.title}
                          </Link>
                        </TD>
                        <TD>
                          <ServiceBadge task={d} category={d.content_category} />
                        </TD>
                        <TD>
                          <Badge tone={statusTone(d.status)}>{label(d.status)}</Badge>
                        </TD>
                        <TD className="text-muted-foreground">{fmtDate(d.due_date)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
