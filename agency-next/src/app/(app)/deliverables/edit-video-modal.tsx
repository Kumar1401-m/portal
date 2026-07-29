"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Pencil, Loader2, Send, Wand2, UploadCloud, Trash2 } from "lucide-react";
import {
  updateVideoDetails,
  generateCaptionAction,
  submitRawOrReference,
  type VideoDetailsState,
  type RawFootageState,
} from "./actions";
import type { DeliverableListRow } from "@/lib/deliverables";
import { serviceOf, type ServiceKey } from "@/lib/services";
import { Modal } from "@/components/ui/modal";
import { VideoUpload } from "./video-upload";
import { deleteDeliverable } from "./upload-actions";
import {
  ServiceCategoryPicker,
  type CategoryOptions,
} from "@/components/admin/service-category-picker";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function EditVideoModal({
  deliverable: d,
  categories,
  canSendToClient,
  canDelete = false,
  assignees = [],
  canUploadVideo = true,
  postCountries = [],
  scheduledAtLocal = "",
  postCountry = "india",
}: {
  deliverable: DeliverableListRow;
  categories: CategoryOptions;
  canSendToClient: boolean;
  canDelete?: boolean;
  assignees?: { id: number; name: string; role: string }[];
  canUploadVideo?: boolean;
  postCountries?: { key: string; label: string }[];
  scheduledAtLocal?: string;
  postCountry?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<VideoDetailsState, FormData>(updateVideoDetails, {
    ok: false,
  });
  const [rawState, rawAction, rawPending] = useActionState<RawFootageState, FormData>(
    submitRawOrReference,
    { ok: false }
  );

  const [caption, setCaption] = useState(d.caption ?? "");
  const [editedLink, setEditedLink] = useState(d.edited_link ?? "");
  // A poster brief is written as one block of copy, so the fields follow the
  // service picker live rather than the value the task was saved with.
  const [service, setService] = useState<ServiceKey>(serviceOf(d));
  const isPoster = service === "poster_designing";
  const [genPending, startGen] = useTransition();
  const [delPending, startDel] = useTransition();
  const [genError, setGenError] = useState<string | null>(null);

  // Reset the caption editor to the latest saved value each time the modal opens.
  useEffect(() => {
    if (open) {
      setCaption(d.caption ?? "");
      setEditedLink(d.edited_link ?? "");
      setService(serviceOf(d));
      setGenError(null);
    }
  }, [open, d]);

  // Close on a successful save.
  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  function generate() {
    setGenError(null);
    startGen(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(d.id));
      const res = await generateCaptionAction({ ok: false }, fd);
      if (res.ok && res.caption) setCaption(res.caption);
      else setGenError(res.error || "Couldn't generate a caption.");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Update details"
        aria-label={`Update ${d.title}`}
        className={buttonClasses({ variant: "ghost", size: "icon" })}
      >
        <Pencil className="h-4 w-4" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Update Task Details">
        {d.status === "waiting_for_raw" ? (
          <form action={rawAction} className="shrink-0 space-y-3 border-b border-border bg-amber-500/5 p-6">
            <input type="hidden" name="deliverable_id" value={d.id} />
            <div className="flex items-center gap-2 text-sm font-medium">
              <UploadCloud className="h-4 w-4 text-amber-600" />
              Waiting for raw footage
            </div>
            <p className="text-xs text-muted-foreground">
              Add the client&apos;s raw footage link, or — if none was provided — paste
              reference / inspiration links so editing can start anyway.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={`rf-${d.id}`}>Raw footage link (Drive, etc.)</Label>
              <Input id={`rf-${d.id}`} name="raw_drive_link" placeholder="https://drive.google.com/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`rl-${d.id}`}>Reference / inspiration links</Label>
              <Textarea
                id={`rl-${d.id}`}
                name="reference_links"
                rows={2}
                placeholder="One or more links, if no raw footage was sent"
              />
            </div>
            {rawState.error ? <p className="text-sm text-destructive">{rawState.error}</p> : null}
            {rawState.ok && rawState.message ? (
              <p className="text-sm text-emerald-600">{rawState.message}</p>
            ) : null}
            <div className="flex justify-end">
              <button type="submit" disabled={rawPending} className={buttonClasses({ size: "sm" })}>
                {rawPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Submit &amp; move to editing
              </button>
            </div>
          </form>
        ) : null}

        <form action={action} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="deliverable_id" value={d.id} />

          <div className="flex-1 space-y-4 overflow-y-auto p-6">
            {/* Re-tag the task's service / category without leaving the list. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <ServiceCategoryPicker
                categories={categories}
                defaultService={serviceOf(d)}
                defaultCategory={d.content_category ?? ""}
                idPrefix={`d${d.id}-`}
                onServiceChange={setService}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`t-${d.id}`}>Title</Label>
              <Input id={`t-${d.id}`} name="title" defaultValue={d.title} />
            </div>

            {assignees.length ? (
              <div className="space-y-1.5">
                <Label htmlFor={`as-${d.id}`}>Assigned to</Label>
                <Select id={`as-${d.id}`} name="assigned_to" defaultValue={d.assigned_to ? String(d.assigned_to) : ""}>
                  <option value="">Unassigned</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {/* A poster has no hook and no script — it has the copy that goes
                on it. One field, and the hook is carried through untouched so
                re-tagging a video as a poster doesn't erase what was written. */}
            {isPoster ? (
              <>
                <input type="hidden" name="content_hook" value={d.content_hook ?? ""} />
                <div className="space-y-1.5">
                  <Label htmlFor={`de-${d.id}`}>Content in this poster</Label>
                  <Textarea
                    id={`de-${d.id}`}
                    name="description"
                    rows={5}
                    defaultValue={d.description ?? ""}
                    placeholder="The text that goes on the poster — offer, dates, contact details. The client sees this at the content approval stage."
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`ch-${d.id}`}>Content in Video</Label>
                  <Textarea id={`ch-${d.id}`} name="content_hook" rows={2} defaultValue={d.content_hook ?? ""} />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`de-${d.id}`}>Content / script</Label>
                  <Textarea
                    id={`de-${d.id}`}
                    name="description"
                    rows={5}
                    defaultValue={d.description ?? ""}
                    placeholder="The script or brief the video is built from — the client sees this at the content approval stage."
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor={`cap-${d.id}`}>Caption / Description</Label>
                <button
                  type="button"
                  onClick={generate}
                  disabled={genPending}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  {genPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {genPending ? "Generating…" : "Generate with AI"}
                </button>
              </div>
              <Textarea
                id={`cap-${d.id}`}
                name="caption"
                rows={5}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write a caption, or generate one with AI."
                className="font-mono text-[13px] leading-relaxed"
              />
              {genError ? <p className="text-sm text-destructive">{genError}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`wn-${d.id}`}>Content Writer Inputs</Label>
              <Textarea id={`wn-${d.id}`} name="writer_notes" rows={2} defaultValue={d.writer_notes ?? ""} />
            </div>

            {postCountries.length ? (
              <div className="space-y-1.5 rounded-lg border border-border p-3">
                <Label htmlFor={`pc-${d.id}`}>Posting time</Label>
                <p className="text-xs text-muted-foreground">
                  Leave blank to post at that country&apos;s best engagement time once the client
                  approves. Set a time to override it.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select id={`pc-${d.id}`} name="post_country" defaultValue={postCountry}>
                    {postCountries.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="datetime-local"
                    name="post_at"
                    defaultValue={scheduledAtLocal}
                    aria-label="Scheduled posting time"
                  />
                </div>
              </div>
            ) : null}

            {canUploadVideo ? (
            <div className="space-y-2">
              <Label>Finished video</Label>
              <VideoUpload
                deliverableId={d.id}
                currentUrl={d.cloud_video_url}
                onUploaded={setEditedLink}
              />
            </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor={`el-${d.id}`}>
                Deliverable Link <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`el-${d.id}`}
                name="edited_link"
                placeholder="Uploaded video fills this in, or paste a Drive / Canva link"
                value={editedLink}
                onChange={(e) => setEditedLink(e.target.value)}
              />
            </div>

            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-4">
            {canDelete ? (
              <button
                type="button"
                disabled={delPending}
                onClick={() => {
                  if (!confirm(`Permanently delete "${d.title}"? This also removes its comments, feedback and uploaded video. There is no undo.`)) return;
                  startDel(async () => {
                    const res = await deleteDeliverable(d.id);
                    if (res.ok) setOpen(false);
                    else alert(res.error || "Could not delete this task.");
                  });
                }}
                className={buttonClasses({ variant: "destructive", size: "sm" })}
              >
                {delPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete task
              </button>
            ) : null}
            <div className="flex-1" />
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <button
              type="submit"
              name="mode"
              value="draft"
              disabled={pending}
              className={buttonClasses({ variant: "secondary" })}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save Draft
            </button>
            {canSendToClient ? (
              <button
                type="submit"
                name="mode"
                value="approval"
                disabled={pending}
                className={buttonClasses()}
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send To Approval
              </button>
            ) : null}
          </div>
        </form>
      </Modal>
    </>
  );
}
