import {
  Settings as SettingsIcon,
  Building2,
  Receipt,
  Activity,
  Lock,
  TriangleAlert,
} from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getPublicSettings } from "@/lib/settings";
import { getCategoryMap } from "@/lib/categories";
import { getTeam } from "@/lib/team";
import { env } from "@/lib/env";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "./action-form";
import { CategoryManager } from "./category-manager";
import { TeamManager } from "./team-manager";
import { saveAgencyProfile, saveBillingSettings, clearAllTasks } from "./actions";

export const metadata = { title: "Settings · NVK Hub" };
export const dynamic = "force-dynamic";

function SuperAdminOnly({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground">
      <Lock className="h-4 w-4 shrink-0" />
      Only a super admin can manage {what}.
    </p>
  );
}

function Status({ label: l, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{l}</span>
      <span className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{detail}</span>
        <Badge tone={ok ? "success" : "muted"}>{ok ? "Connected" : "Not configured"}</Badge>
      </span>
    </div>
  );
}

export default async function SettingsPage() {
  // Admins see every module, but a few sensitive actions (billing, team
  // management) are reserved for super_admin — enforced both here (what
  // renders) and in the server actions themselves (what's allowed to run).
  const user = await requireUser(ADMIN_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const [settings, categories, team] = await Promise.all([
    getPublicSettings(),
    getCategoryMap(true), // include hidden ones so they can be re-enabled
    getTeam(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="h-6 w-6 text-primary" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Agency profile, billing, task categories and team access.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --------------------------- Agency profile --------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" /> Agency profile
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={saveAgencyProfile}
              submitLabel="Save profile"
              formClassName="space-y-4"
            >
              <div className="space-y-1.5">
                <Label htmlFor="company_name">Agency name *</Label>
                <Input id="company_name" name="company_name" defaultValue={settings.company_name} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="company_email">Contact email</Label>
                  <Input
                    id="company_email"
                    name="company_email"
                    type="email"
                    defaultValue={settings.company_email}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contact_number">Phone</Label>
                  <Input
                    id="contact_number"
                    name="contact_number"
                    defaultValue={settings.contact_number}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="business_address">Business address</Label>
                <Textarea
                  id="business_address"
                  name="business_address"
                  rows={2}
                  defaultValue={settings.business_address}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company_logo_url">Logo URL</Label>
                <Input
                  id="company_logo_url"
                  name="company_logo_url"
                  placeholder="https://…"
                  defaultValue={settings.company_logo_url}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="powered_by">Invoice / email footer</Label>
                <Input id="powered_by" name="powered_by" defaultValue={settings.powered_by} />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        {/* ---------------------------- Billing ---------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-muted-foreground" /> Invoicing &amp; payments
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!isSuperAdmin ? (
              <SuperAdminOnly what="billing and payment integration settings" />
            ) : (
            <ActionForm
              action={saveBillingSettings}
              submitLabel="Save billing"
              formClassName="space-y-4"
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="invoice_prefix">Invoice prefix</Label>
                  <Input
                    id="invoice_prefix"
                    name="invoice_prefix"
                    defaultValue={settings.invoice_prefix}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tax_percent">Tax %</Label>
                  <Input
                    id="tax_percent"
                    name="tax_percent"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    defaultValue={settings.tax_percent}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="processing_fee_percent">Processing fee %</Label>
                  <Input
                    id="processing_fee_percent"
                    name="processing_fee_percent"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    defaultValue={settings.processing_fee_percent}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="razorpay_key_id">Razorpay key ID</Label>
                <Input
                  id="razorpay_key_id"
                  name="razorpay_key_id"
                  placeholder="rzp_live_…"
                  defaultValue={settings.razorpay_key_id}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="razorpay_key_secret">
                  Razorpay key secret{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {settings.razorpay_key_secret_set
                      ? "· saved — leave blank to keep it"
                      : "· not set"}
                  </span>
                </Label>
                <Input
                  id="razorpay_key_secret"
                  name="razorpay_key_secret"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.razorpay_key_secret_set ? "••••••••" : "Paste the secret"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                These values are shared with the original portal — both apps read
                the same <code>settings</code> table.
              </p>
            </ActionForm>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ------------------------- Task categories ------------------------- */}
      <CategoryManager categories={categories} />

      {/* ------------------------------ Team ------------------------------ */}
      {isSuperAdmin ? (
        <TeamManager team={team} currentUserId={user.id} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
          </CardHeader>
          <CardContent>
            <SuperAdminOnly what="the team (adding staff, deactivating accounts, resetting passwords)" />
          </CardContent>
        </Card>
      )}

      {/* --------------------------- System status --------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" /> System status
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <Status
            label="Database"
            ok
            detail={`${env.db.database} @ ${env.db.host}:${env.db.port}`}
          />
          <Status
            label="AI captions (Gemini)"
            ok={env.gemini.enabled}
            detail={env.gemini.enabled ? env.gemini.model : "set GEMINI_API_KEY in .env.local"}
          />
          <Status
            label="Outbound email (SMTP)"
            ok={env.mail.enabled}
            detail={env.mail.enabled ? env.mail.host : "set SMTP_HOST / SMTP_USER in .env.local"}
          />
          <Status
            label="Razorpay checkout"
            ok={Boolean(settings.razorpay_key_id && settings.razorpay_key_secret_set)}
            detail={settings.razorpay_key_id || "add your keys above"}
          />
        </CardContent>
      </Card>

      {/* ---------------------------- Danger zone ---------------------------- */}
      {isSuperAdmin ? (
        <Card className="border-[color-mix(in_srgb,var(--destructive)_40%,var(--border))]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="h-5 w-5" /> Danger zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-1 text-sm font-medium">Clear all tasks</p>
            <p className="mb-3 text-sm text-muted-foreground">
              Permanently deletes every task, along with its comments and feedback, so you
              can start fresh. Clients, team members and settings are kept. This cannot be
              undone.
            </p>
            <ActionForm
              action={clearAllTasks}
              submitLabel="Clear all tasks"
              variant="destructive"
              size="sm"
              resetOnSuccess
              confirm="This permanently deletes EVERY task in the portal. There is no undo. Continue?"
              formClassName="flex flex-wrap items-end gap-2"
            >
              <div className="space-y-1.5">
                <Label htmlFor="confirm-clear">Type DELETE to confirm</Label>
                <Input
                  id="confirm-clear"
                  name="confirm"
                  autoComplete="off"
                  placeholder="DELETE"
                  className="h-9 max-w-[12rem]"
                />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
