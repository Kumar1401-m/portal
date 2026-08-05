import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Designer } from "@/lib/clients";
import type { CrmUserOption } from "@/lib/crm";
import { SERVICE_LIST, type ServiceKey } from "@/lib/services";
import { cn } from "@/lib/utils";

export type ClientDefaults = Partial<{
  id: number;
  company_name: string;
  contact_person: string;
  business_type: string;
  status: string;
  email: string;
  phone: string;
  website: string;
  instagram_link: string;
  facebook_link: string;
  youtube_link: string;
  monthly_package: string;
  package_amount: string;
  monthly_deliverables: string;
  monthly_posters: string;
  category: string;
  payment_plan: string;
  joining_date: string;
  renewal_date: string;
  notes: string;
  designer_id: string;
  caption_language: string;
  caption_tone: string;
  loc_city: string;
  loc_country: string;
  loc_whatsapp: string;
  services: ServiceKey[];
  ig_user_id: string;
  ig_username: string;
  ig_access_token: string;
  whatsapp_number: string;
  auto_publish: boolean;
  is_personal: boolean;
  crm_user_ids: number[];
}>;

function Field({
  label,
  name,
  children,
}: {
  label: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      {children}
    </div>
  );
}

export function ClientForm({
  action,
  defaults = {},
  designers,
  isCreate,
  submitButton,
  crmUsers = [],
  canManageCrmAccess = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaults?: ClientDefaults;
  designers: Designer[];
  isCreate: boolean;
  submitButton: React.ReactNode;
  /** Active crm-role users, for the access checklist below. */
  crmUsers?: CrmUserOption[];
  /** Only super_admin may assign crm access or mark a client personal. */
  canManageCrmAccess?: boolean;
}) {
  const d = defaults;
  return (
    <form action={action} className="space-y-6">
      {d.id ? <input type="hidden" name="id" value={d.id} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Company</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field label="Company name *" name="company_name">
            <Input id="company_name" name="company_name" required defaultValue={d.company_name} />
          </Field>
          <Field label="Contact person" name="contact_person">
            <Input id="contact_person" name="contact_person" defaultValue={d.contact_person} />
          </Field>
          <Field label="Business type" name="business_type">
            <Input id="business_type" name="business_type" placeholder="e.g. Restaurant, Dental clinic" defaultValue={d.business_type} />
          </Field>
          <Field label="Status" name="status">
            <Select id="status" name="status" defaultValue={d.status || "active"}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="inactive">Inactive</option>
              <option value="churned">Churned</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Required services</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Which services has this client signed up for? Used for filtering and
            reporting only — it never restricts what the team can create for them.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICE_LIST.map((s) => {
              const checked = (d.services ?? []).includes(s.key);
              return (
                <label
                  key={s.key}
                  htmlFor={`svc-${s.key}`}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/60"
                >
                  <input
                    id={`svc-${s.key}`}
                    type="checkbox"
                    name="services"
                    value={s.key}
                    defaultChecked={checked}
                    className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", s.dot)} />
                  <span className="text-sm">{s.label}</span>
                </label>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contact &amp; social</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field label="Email" name="email">
            <Input id="email" name="email" type="email" defaultValue={d.email} />
          </Field>
          <Field label="Phone" name="phone">
            <Input id="phone" name="phone" defaultValue={d.phone} />
          </Field>
          <Field label="Website" name="website">
            <Input id="website" name="website" placeholder="https://" defaultValue={d.website} />
          </Field>
          <Field label="Instagram link" name="instagram_link">
            <Input id="instagram_link" name="instagram_link" placeholder="https://instagram.com/…" defaultValue={d.instagram_link} />
          </Field>
          <Field label="Facebook link" name="facebook_link">
            <Input id="facebook_link" name="facebook_link" placeholder="https://facebook.com/…" defaultValue={d.facebook_link} />
          </Field>
          <Field label="YouTube link" name="youtube_link">
            <Input id="youtube_link" name="youtube_link" placeholder="https://youtube.com/…" defaultValue={d.youtube_link} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instagram automation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Lets the portal publish this client&apos;s approved Reels at their scheduled time. The
            account must be an Instagram <b>Business</b> account attached to a Facebook Page you
            administer.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Instagram Business account id" name="ig_user_id">
              <Input
                id="ig_user_id"
                name="ig_user_id"
                placeholder="e.g. 17841415221535647"
                defaultValue={d.ig_user_id}
              />
            </Field>
            <Field label="Instagram handle" name="ig_username">
              <Input
                id="ig_username"
                name="ig_username"
                placeholder="without the @"
                defaultValue={d.ig_username}
              />
            </Field>
            <Field label="WhatsApp number" name="whatsapp_number">
              <Input
                id="whatsapp_number"
                name="whatsapp_number"
                placeholder="+91 98765 43210"
                defaultValue={d.whatsapp_number}
              />
            </Field>
            <Field label="Page access token (optional)" name="ig_access_token">
              <Input
                id="ig_access_token"
                name="ig_access_token"
                type="password"
                placeholder="leave blank to use the agency token"
                defaultValue={d.ig_access_token}
              />
            </Field>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">
            The token is only needed when this account sits outside your own Business Manager.
            Leave it blank and the automation uses the agency-wide token.
          </p>

          {/*
            Auto-publishing is off unless someone deliberately turns it on. The
            failure mode of a default-on switch here is a post appearing on a
            real client account that nobody approved, so it is opt-in per client
            and the label says exactly what it does.
          */}
          <label
            htmlFor="auto_publish"
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/60"
          >
            <input
              id="auto_publish"
              type="checkbox"
              name="auto_publish"
              value="1"
              defaultChecked={d.auto_publish}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
            />
            <span className="text-sm">
              <span className="font-medium">Publish approved Reels automatically</span>
              <br />
              <span className="text-muted-foreground">
                Once a Reel is approved and scheduled, it posts itself at that time — no one has
                to be at a desk. The client is emailed and WhatsApped when it goes live.
              </span>
            </span>
          </label>

        </CardContent>
      </Card>

      {canManageCrmAccess ? (
        <Card>
          <CardHeader>
            <CardTitle>CRM access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label
              htmlFor="is_personal"
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/60"
            >
              <input
                id="is_personal"
                type="checkbox"
                name="is_personal"
                value="1"
                defaultChecked={d.is_personal}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
              />
              <span className="text-sm">
                <span className="font-medium">Personal client</span>
                <br />
                <span className="text-muted-foreground">
                  Excludes this client from being newly assigned to a CRM user below.
                  Doesn&apos;t remove access already granted.
                </span>
              </span>
            </label>

            <div>
              <p className="mb-2 text-sm font-medium">CRM users who can access this client</p>
              {crmUsers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No CRM team members yet — add one in Settings → Team.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {crmUsers.map((u) => (
                    <label
                      key={u.id}
                      htmlFor={`crm-${u.id}`}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-muted/60"
                    >
                      <input
                        id={`crm-${u.id}`}
                        type="checkbox"
                        name="crm_user_ids"
                        value={u.id}
                        defaultChecked={d.crm_user_ids?.includes(u.id)}
                        className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                      />
                      <span className="text-sm">{u.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Package</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Package name" name="monthly_package">
            <Input id="monthly_package" name="monthly_package" placeholder="e.g. Growth" defaultValue={d.monthly_package} />
          </Field>
          <Field label="Package amount (₹)" name="package_amount">
            <Input id="package_amount" name="package_amount" type="number" min="0" step="1" defaultValue={d.package_amount} />
          </Field>
          <Field label="Monthly videos" name="monthly_deliverables">
            <Input id="monthly_deliverables" name="monthly_deliverables" type="number" min="0" defaultValue={d.monthly_deliverables} />
          </Field>
          <Field label="Monthly posters" name="monthly_posters">
            <Input id="monthly_posters" name="monthly_posters" type="number" min="0" defaultValue={d.monthly_posters} />
          </Field>
          {/* The tier shown in the Category column of the monthly report. */}
          <Field label="Category (report tier)" name="category">
            <Input
              id="category"
              name="category"
              maxLength={10}
              placeholder="A, B or C"
              defaultValue={d.category}
            />
          </Field>
          <Field label="Payment plan" name="payment_plan">
            <Select id="payment_plan" name="payment_plan" defaultValue={d.payment_plan || "monthly"}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="half_yearly">Half-yearly</option>
              <option value="yearly">Yearly</option>
              <option value="one_time">One-time</option>
            </Select>
          </Field>
          <Field label="Joining date" name="joining_date">
            <Input id="joining_date" name="joining_date" type="date" defaultValue={d.joining_date} />
          </Field>
          <Field label="Renewal date" name="renewal_date">
            <Input id="renewal_date" name="renewal_date" type="date" defaultValue={d.renewal_date} />
          </Field>
          <Field label="Default designer" name="designer_id">
            <Select id="designer_id" name="designer_id" defaultValue={d.designer_id || ""}>
              <option value="">— None —</option>
              {designers.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI caption localization</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            These drive the AI Caption Studio — set the city &amp; country so captions
            localize (e.g. an Australian café gets Sydney-area hashtags).
          </p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Caption language" name="caption_language">
              <Select id="caption_language" name="caption_language" defaultValue={d.caption_language || "English"}>
                <option value="English">English</option>
                <option value="Telugu">Telugu</option>
                <option value="Tenglish">Tenglish</option>
                <option value="Hindi">Hindi</option>
              </Select>
            </Field>
            <Field label="Caption tone" name="caption_tone">
              <Select id="caption_tone" name="caption_tone" defaultValue={d.caption_tone || "Friendly"}>
                <option>Friendly</option>
                <option>Professional</option>
                <option>Playful</option>
                <option>Luxury</option>
                <option>Bold</option>
              </Select>
            </Field>
            <Field label="City / area" name="loc_city">
              <Input id="loc_city" name="loc_city" placeholder="e.g. Bondi Beach" defaultValue={d.loc_city} />
            </Field>
            <Field label="Country" name="loc_country">
              <Input id="loc_country" name="loc_country" placeholder="e.g. Australia" defaultValue={d.loc_country} />
            </Field>
            <Field label="WhatsApp" name="loc_whatsapp">
              <Input id="loc_whatsapp" name="loc_whatsapp" defaultValue={d.loc_whatsapp} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes{isCreate ? " & portal login" : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Internal notes" name="notes">
            <Textarea id="notes" name="notes" rows={3} defaultValue={d.notes} />
          </Field>
          {isCreate ? (
            <Field label="Portal password (optional — creates a client login)" name="portal_password">
              <Input
                id="portal_password"
                name="portal_password"
                type="text"
                placeholder="Min 8 chars — requires an email above"
                autoComplete="off"
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex justify-end">{submitButton}</div>
    </form>
  );
}
