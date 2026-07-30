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
import { buttonClasses } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BriefFields } from "./brief-fields";
import { label } from "@/lib/utils";

/**
 * The create-a-task form, shared by the /deliverables/new page and the popup
 * that intercepts it.
 *
 * It has to be shared: the popup route sits next to `[id]`, so "new" matches
 * as a task id and the interception fires either way. Rather than fight that,
 * both render this.
 */
export async function NewTaskForm({
  error,
  service,
  client,
  month,
  inModal = false,
}: {
  error?: string;
  service?: string;
  /** Pre-selected client — set when coming from that client's report. */
  client?: string;
  /** Pre-fills the due date into this month, so the task lands where you were. */
  month?: string;
  inModal?: boolean;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  // A crm only ever picks from the clients they have access to.
  const scopeIds = await crmClientIds(user);
  const [clients, assignees, categories] = await Promise.all([
    getClientsMini(scopeIds),
    getAssignees(),
    getCategoryMap(),
  ]);
  // Coming from a service tab pre-selects that service.
  const defaultService = isServiceKey(service) ? service : "video_editing";
  // Only honour a client the signed-in user can actually pick — the action
  // checks access again anyway, but an unpickable option would just confuse.
  const defaultClient = clients.some((c) => String(c.id) === client) ? client! : "";
  // The due date decides which month the task is reported in, so a task added
  // from a month's report defaults into that month rather than today's.
  const defaultDue = /^\d{4}-\d{2}$/.test(month || "") ? `${month}-01` : "";
  const sp = { error };

  return (
    <div className={inModal ? "space-y-6" : "mx-auto max-w-3xl space-y-6"}>
      {/* In a popup the header bar already says "New task". */}
      {inModal ? null : (
        <div className="flex items-center gap-3">
          <Link href="/deliverables" className={buttonClasses({ variant: "ghost", size: "icon" })}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">New task</h1>
        </div>
      )}

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
            {/* Every task belongs to a service and a category — and the brief
                fields below the picker follow whichever one is chosen. */}
            <BriefFields categories={categories} defaultService={defaultService}>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="client_id">Client *</Label>
                  <Select id="client_id" name="client_id" required defaultValue={defaultClient}>
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
                  <Input id="due_date" name="due_date" type="date" defaultValue={defaultDue} />
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
            </BriefFields>

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
          <SubmitButton pendingLabel="Creating…">Create deliverable</SubmitButton>
        </div>
      </form>
    </div>
  );
}
