import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { getClientsMini } from "@/lib/deliverables";
import { buttonClasses } from "@/components/ui/button";
import { InvoiceForm } from "./invoice-form";

export const metadata = { title: "New invoice · NVK Hub" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  amount: "Pick a client and enter an amount greater than zero.",
  client: "That client no longer exists.",
  failed: "Could not create the invoice — please try again.",
};

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser(SUPER_ADMIN_ROLES);
  const [clients, sp] = await Promise.all([getClientsMini(), searchParams]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/payments" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
      </div>

      {sp.error ? (
        <p className="rounded-md bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] px-3 py-2 text-sm text-destructive">
          {ERRORS[sp.error] || "Something went wrong."}
        </p>
      ) : null}

      <InvoiceForm clients={clients} />
    </div>
  );
}
