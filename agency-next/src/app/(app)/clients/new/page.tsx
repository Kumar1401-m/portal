import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getDesigners, getEditors } from "@/lib/clients";
import { getCrmUsers } from "@/lib/crm";
import { getLead } from "@/lib/leads";
import { createClient } from "../actions";
import { ClientForm } from "../client-form";
import { Button, buttonClasses } from "@/components/ui/button";

export const metadata = { title: "New client · NVK Hub" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  name: "Please enter a company name (min 2 characters).",
  email: "A portal password needs a client email too.",
  dupemail: "That email already has a login account.",
  failed: "Could not create the client — please try again.",
};

export default async function NewClientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; lead?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const [designers, editors, crmUsers, sp] = await Promise.all([
    getDesigners(),
    getEditors(),
    isSuperAdmin ? getCrmUsers() : Promise.resolve([]),
    searchParams,
  ]);

  /*
   * Arriving from a won lead, with what was already typed once.
   *
   * Only the four fields the pipeline actually holds — the rest of this form
   * is the deal, and a deal is not something a lead record knows. The lead is
   * not marked or linked here: it is already marked won, and this form can be
   * abandoned halfway.
   */
  const leadId = Number(sp.lead);
  const lead = Number.isInteger(leadId) && leadId > 0 ? await getLead(leadId) : null;
  const defaults = lead
    ? {
        company_name: lead.company || lead.name,
        contact_person: lead.name,
        phone: lead.phone ?? "",
        email: lead.email ?? "",
        package_amount: lead.value ? String(lead.value) : "",
        notes: lead.note ?? "",
      }
    : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/clients" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New client</h1>
      </div>

      {sp.error ? (
        <p className="rounded-md bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] px-3 py-2 text-sm text-destructive">
          {ERRORS[sp.error] || "Something went wrong."}
        </p>
      ) : null}

      <ClientForm
        action={createClient}
        designers={designers}
        editors={editors}
        defaults={defaults}
        isCreate
        submitButton={<Button type="submit">Create client</Button>}
        crmUsers={crmUsers}
        canManageCrmAccess={isSuperAdmin}
      />
    </div>
  );
}
