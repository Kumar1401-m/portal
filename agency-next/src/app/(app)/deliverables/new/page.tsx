import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini, getAssignees } from "@/lib/deliverables";
import { getCategoryMap } from "@/lib/categories";
import { isServiceKey } from "@/lib/services";
import { PLATFORMS, PRIORITIES } from "@/lib/constants";
import { createDeliverable } from "../actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ServiceCategoryPicker } from "@/components/admin/service-category-picker";
import { label } from "@/lib/utils";

export const metadata = { title: "New task · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function NewDeliverablePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; service?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  // A crm only ever picks from the clients they have access to.
  const scopeIds = await crmClientIds(user);
  const [clients, assignees, categories, sp] = await Promise.all([
    getClientsMini(scopeIds),
    getAssignees(),
    getCategoryMap(),
    searchParams,
  ]);
  // Coming from a service tab pre-selects that service.
  const defaultService = isServiceKey(sp.service) ? sp.service : "video_editing";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/deliverables" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New task</h1>
      </div>

      {sp.error ? (
        <p className="rounded-md bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] px-3 py-2 text-sm text-destructive">
          {sp.error === "notfound"
            ? "That client no longer exists."
            : sp.error === "category"
              ? "Please choose a service and a category for this task."
              : "Please pick a client and enter a title (min 2 characters)."}
        </p>
      ) : null}

      <form action={createDeliverable}>
        <Card>
          <CardHeader>
            <CardTitle>Content brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Every task belongs to a service and a category. */}
            <div className="grid gap-5 sm:grid-cols-2">
              <ServiceCategoryPicker categories={categories} defaultService={defaultService} />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="client_id">Client *</Label>
                <Select id="client_id" name="client_id" required defaultValue="">
                  <option value="" disabled>
                    Select a client…
                  </option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company_name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="due_date">Due date</Label>
                <Input id="due_date" name="due_date" type="date" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="title">Title *</Label>
              <Input id="title" name="title" required placeholder="e.g. Diwali offer reel" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assigned_to">Assign to</Label>
              <Select id="assigned_to" name="assigned_to" defaultValue="">
                <option value="">Use the client&apos;s default designer</option>
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Description / script</Label>
              <Textarea
                id="description"
                name="description"
                rows={4}
                placeholder="What is this content about? The AI uses this to write the caption."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="content_hook">Content hook</Label>
              <Input id="content_hook" name="content_hook" placeholder="The opening line / angle" />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="platform">Platform</Label>
                <Select id="platform" name="platform" defaultValue="instagram_reel">
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {label(p)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="priority">Priority</Label>
                <Select id="priority" name="priority" defaultValue="medium">
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p} className="capitalize">
                      {label(p)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="language">Caption language</Label>
                <Select id="language" name="language" defaultValue="English">
                  <option value="English">English</option>
                  <option value="Telugu">Telugu</option>
                  <option value="Tenglish">Tenglish (Telugu in English letters)</option>
                  <option value="Hindi">Hindi</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="target_audience">Target audience</Label>
                <Input id="target_audience" name="target_audience" placeholder="e.g. Local families, 25-45" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="custom_instructions">Custom AI instructions</Label>
              <Textarea
                id="custom_instructions"
                name="custom_instructions"
                rows={2}
                placeholder="Anything specific the caption must include or avoid (e.g. Australian spelling, local hashtags)."
              />
            </div>
          </CardContent>
        </Card>

        <div className="mt-5 flex justify-end gap-2">
          <Link href="/deliverables" className={buttonClasses({ variant: "outline" })}>
            Cancel
          </Link>
          <Button type="submit">Create deliverable</Button>
        </div>
      </form>
    </div>
  );
}
