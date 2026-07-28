import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getClientDetail, getDesigners } from "@/lib/clients";
import { getCrmUsers, getClientCrmUserIds } from "@/lib/crm";
import { updateClient } from "../../actions";
import { ClientForm, type ClientDefaults } from "../../client-form";
import { parseClientServices } from "@/lib/services";
import { Button, buttonClasses } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit client · NVK Hub" };

const str = (v: unknown) => (v == null ? "" : String(v));

export default async function EditClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser(ADMIN_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const { id } = await params;
  const [client, designers, crmUsers, assignedCrmIds, sp] = await Promise.all([
    getClientDetail(Number(id)),
    getDesigners(),
    isSuperAdmin ? getCrmUsers() : Promise.resolve([]),
    isSuperAdmin ? getClientCrmUserIds(Number(id)) : Promise.resolve([]),
    searchParams,
  ]);
  if (!client) notFound();

  const cs = (client.caption_settings && typeof client.caption_settings === "object"
    ? client.caption_settings
    : {}) as Record<string, unknown>;
  const ph = (client.placeholder_values && typeof client.placeholder_values === "object"
    ? client.placeholder_values
    : {}) as Record<string, unknown>;

  const defaults: ClientDefaults = {
    id: client.id,
    company_name: str(client.company_name),
    contact_person: str(client.contact_person),
    business_type: str(client.business_type),
    status: str(client.status),
    email: str(client.email),
    phone: str(client.phone),
    website: str(client.website),
    instagram_link: str(client.instagram_link),
    facebook_link: str(client.facebook_link),
    youtube_link: str(client.youtube_link),
    monthly_package: str(client.monthly_package),
    package_amount: str(client.package_amount),
    monthly_deliverables: str(client.monthly_deliverables),
    payment_plan: str(client.payment_plan),
    joining_date: str(client.joining_date).slice(0, 10),
    renewal_date: str(client.renewal_date).slice(0, 10),
    notes: str(client.notes),
    designer_id: client.designer_id ? String(client.designer_id) : "",
    caption_language: str(cs.language),
    caption_tone: str(cs.tone),
    loc_city: str(ph.location),
    loc_country: str(ph.country),
    loc_whatsapp: str(ph.whatsapp),
    services: parseClientServices(client.services),
    ig_user_id: str(client.ig_user_id),
    is_personal: Boolean(client.is_personal),
    crm_user_ids: assignedCrmIds,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/clients/${client.id}`} className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit {client.company_name}</h1>
      </div>

      {sp.error ? (
        <p className="rounded-md bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] px-3 py-2 text-sm text-destructive">
          Please enter a company name (min 2 characters).
        </p>
      ) : null}

      <ClientForm
        action={updateClient}
        defaults={defaults}
        designers={designers}
        isCreate={false}
        submitButton={<Button type="submit">Save changes</Button>}
        crmUsers={crmUsers}
        canManageCrmAccess={isSuperAdmin}
      />
    </div>
  );
}
