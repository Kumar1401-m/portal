import {
  Settings as SettingsIcon,
  Building2,
  Receipt,
  Activity,
  Lock,
  CloudUpload,
} from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { getPublicSettings } from "@/lib/settings";
import { getCategoryMap } from "@/lib/categories";
import { getTeam } from "@/lib/team";
import { schemaStatus } from "@/lib/schema-sync";
import { env } from "@/lib/env";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "./action-form";
import { CategoryManager } from "./category-manager";
import { TeamManager } from "./team-manager";
import { SchemaPanel } from "./schema-panel";
import { saveAgencyProfile, saveBillingSettings, saveStorageSettings } from "./actions";

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
  const [settings, categories, team, schema] = await Promise.all([
    getPublicSettings(),
    getCategoryMap(true), // include hidden ones so they can be re-enabled
    getTeam(),
    // Only a super admin can apply these, so only they need the status.
    isSuperAdmin ? schemaStatus() : Promise.resolve([]),
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

      {/* --------------------------- Video hosting --------------------------- */}
      {isSuperAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CloudUpload className="h-5 w-5 text-muted-foreground" /> Video hosting (Cloudflare R2)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Lets editors upload the finished video straight into a task, and clients watch it
              inside the portal instead of being sent to Google Drive. R2&apos;s free tier gives 10 GB
              with no charge for viewing. Create a bucket at{" "}
              <span className="font-mono text-xs">dash.cloudflare.com → R2</span>, then paste its
              details here.
            </p>
            <ActionForm
              action={saveStorageSettings}
              submitLabel="Save video hosting"
              formClassName="grid gap-4 sm:grid-cols-2"
            >
              <div className="space-y-1.5">
                <Label htmlFor="r2_account_id">Account ID</Label>
                <Input
                  id="r2_account_id"
                  name="r2_account_id"
                  placeholder="e.g. 8f1c2d3e4b5a6789"
                  defaultValue={settings.r2_account_id}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r2_bucket">Bucket name</Label>
                <Input
                  id="r2_bucket"
                  name="r2_bucket"
                  placeholder="e.g. nvk-videos"
                  defaultValue={settings.r2_bucket}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r2_access_key_id">Access key ID</Label>
                <Input
                  id="r2_access_key_id"
                  name="r2_access_key_id"
                  defaultValue={settings.r2_access_key_id}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r2_secret_access_key">
                  Secret access key{" "}
                  <span className="text-xs text-muted-foreground">(blank = unchanged)</span>
                </Label>
                <Input
                  id="r2_secret_access_key"
                  name="r2_secret_access_key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.r2_secret_access_key_set ? "••••••••" : "Paste the secret"}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="r2_public_base_url">
                  Public bucket URL{" "}
                  <span className="text-xs text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="r2_public_base_url"
                  name="r2_public_base_url"
                  placeholder="https://pub-xxxx.r2.dev  or  https://videos.yourdomain.com"
                  defaultValue={settings.r2_public_base_url}
                />
                <p className="text-xs text-muted-foreground">
                  Leave this blank to keep the bucket private — videos are then served through
                  short-lived signed links, which is the safer default. You do still need to add
                  this site to the bucket&apos;s CORS policy with <code>PUT</code> allowed, or the
                  browser will block uploads.
                </p>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

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
          <Status
            label="Video hosting (R2)"
            ok={Boolean(
              settings.r2_account_id &&
                settings.r2_bucket &&
                settings.r2_access_key_id &&
                settings.r2_secret_access_key_set
            )}
            detail={
              settings.r2_bucket
                ? `${settings.r2_bucket} · ${
                    settings.r2_public_base_url ? "public URL" : "private, signed links"
                  }`
                : "add your R2 details above"
            }
          />
        </CardContent>
      </Card>

      {isSuperAdmin ? <SchemaPanel initial={schema} /> : null}
    </div>
  );
}
