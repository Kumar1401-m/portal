import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { getDesigners } from "@/lib/clients";
import { getCrmUsers } from "@/lib/crm";
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
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const [designers, crmUsers, sp] = await Promise.all([
    getDesigners(),
    isSuperAdmin ? getCrmUsers() : Promise.resolve([]),
    searchParams,
  ]);

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
        isCreate
        submitButton={<Button type="submit">Create client</Button>}
        crmUsers={crmUsers}
        canManageCrmAccess={isSuperAdmin}
      />
    </div>
  );
}
