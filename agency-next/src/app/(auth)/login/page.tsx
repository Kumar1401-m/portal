import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";
import { getSession, homeForRole } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · NVK Hub" };

export default async function LoginPage() {
  const user = await getSession();
  if (user) redirect(homeForRole(user.role));

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 lg:block">
        <div className="absolute inset-0 opacity-20 [background:radial-gradient(60rem_60rem_at_20%_-10%,white,transparent)]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-6 w-6" />
            NVK Hub
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-bold leading-tight">
              Run your marketing agency in one place.
            </h1>
            <p className="max-w-md text-white/80">
              Clients, deliverables, AI captions, posters, approvals, invoices &
              payments — the full ERP, CRM and client portal.
            </p>
          </div>
          <p className="text-sm text-white/60">
            © {new Date().getFullYear()} NVK Hub
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2 text-lg font-semibold text-primary">
              <Sparkles className="h-6 w-6" />
              NVK Hub
            </div>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">
            Sign in to your account to continue.
          </p>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
