"use client";

import { useActionState, useState, useTransition } from "react";
import { Pencil, Loader2, Send, Wand2, UploadCloud, Trash2 } from "lucide-react";
import {
  updateVideoDetails,
  generateCaptionAction,
  submitRawOrReference,
  type VideoDetailsState,
  type RawFootageState,
} from "./actions";
import type { DeliverableListRow } from "@/lib/deliverables";
import { acceptsRaw } from "@/lib/raw-footage";
import { serviceOf, type ServiceKey } from "@/lib/services";
import { Modal } from "@/components/ui/modal";
import { VideoUpload, CaptionLine, type CaptionNote } from "./video-upload";
import { useToast } from "@/components/ui/toast";
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
}: {
  deliverable: DeliverableListRow;
  categories: CategoryOptions;
  canSendToClient: boolean;
  canDelete?: boolean;
  assignees?: { id: number; name: string; role: string }[];
  canUploadVideo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VideoDetailsState>({ ok: false });
  const [pending, startSave] = useTransition();
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
  /*
   * The caption the uploader is writing by itself.
   *
   * Tracked separately from a manual generation only so the button can be
   * disabled during it. What is *said* about either comes from one place —
   * see captionNote.
   */
  const [autoCaptioning, setAutoCaptioning] = useState(false);
  const [delPending, startDel] = useTransition();
  /*
   * The single sentence about the caption AI.
   *
   * Both routes to a caption — pressing Generate, and uploading a video that
   * captions itself — write here, and it is rendered once, under the caption
   * box. Previously the button narrated one and the uploader narrated the
   * other, so one activity produced two simultaneous messages saying the same
   * thing in different words.
   */
  const [captionNote, setCaptionNote] = useState<CaptionNote>(null);
  const toast = useToast();
  const captioning = genPending || autoCaptioning;

  /*
   * Reset the editor to the saved values each time the modal opens.
   *
   * Adjusted during render rather than from an effect. These four are real
   * state — they are edited — so they cannot be derived outright, but
   * "the modal just opened" is a change this component can see while
   * rendering, and React re-runs before painting. From an effect it showed the
   * previous task's caption for a frame, which on a fast click looks like the
   * wrong task opened.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCaption(d.caption ?? "");
      setEditedLink(d.edited_link ?? "");
      setService(serviceOf(d));
      setCaptionNote(null);
    }
  }

  /*
   * Save, close, and say so somewhere that outlives the close.
   *
   * This modal is the main place a video is sent to a client, and its success
   * line lived inside the panel that disappears the instant it succeeds.
   * Nobody ever saw it. The reasonable reading of a modal that closes silently
   * is that nothing happened, and the reasonable response is to open it and
   * press Send again — which sends the client the same video twice.
   *
   * Awaited here rather than watched from an effect, so closing and confirming
   * are consequences of the click instead of a render that exists to have a
   * side effect.
   */
  function save(formData: FormData) {
    startSave(async () => {
      const res = await updateVideoDetails({ ok: false }, formData);
      setState(res);
      if (!res.ok) return;
      setOpen(false);
      // A send holds the screen until it is acknowledged; a save does not.
      // The modal has just closed under both, and only one of them is a thing
      // the client has already received.
      toast(
        res.mode === "approval"
          ? {
              title: "Sent for approval",
              description:
                res.message ||
                `${d.company_name} can reply OK in their WhatsApp group to approve it.`,
              ack: true,
            }
          : { title: "Saved", description: `"${d.title}" updated.` }
      );
    });
  }

  function generate() {
    setCaptionNote({ text: "Writing a caption…", tone: "busy" });
    startGen(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(d.id));
      const res = await generateCaptionAction({ ok: false }, fd);
      if (res.ok && res.caption) {
        setCaption(res.caption);
        // Which source it came from is the difference between a caption about
        // what is on screen and one about what somebody typed weeks ago, so
        // say it rather than leaving both looking equally authoritative.
        setCaptionNote({
          text: res.fromVideo
            ? "Written from the video."
            : "Written from the brief — upload the video for one based on the footage.",
          tone: "done",
        });
      } else {
        setCaptionNote({
          text: res.error || "Couldn't generate a caption.",
          tone: "error",
        });
      }
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
        {acceptsRaw(d.status) ? (
          <form action={rawAction} className="shrink-0 space-y-3 border-b border-border bg-amber-500/5 p-6">
            <input type="hidden" name="deliverable_id" value={d.id} />
            <div className="flex items-center gap-2 text-sm font-medium">
              <UploadCloud className="h-4 w-4 text-amber-600" />
              {d.status === "waiting_for_raw" ? "Waiting for raw footage" : "Raw footage"}
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

        <form action={save} className="flex min-h-0 flex-1 flex-col">
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
                {/* The label does not change while it works. A spinner and a
                    disabled button already say "busy", and the line below says
                    what is actually happening — a button that also narrates is
                    the same sentence twice. */}
                <button
                  type="button"
                  onClick={generate}
                  disabled={captioning}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  {captioning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  Generate with AI
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
              {/* The one line. Everything the caption AI has to say, from
                  either route, appears here and nowhere else. */}
              {captionNote ? <CaptionLine note={captionNote} /> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`wn-${d.id}`}>Content Writer Inputs</Label>
              <Textarea id={`wn-${d.id}`} name="writer_notes" rows={2} defaultValue={d.writer_notes ?? ""} />
            </div>

            {canUploadVideo ? (
            <div className="space-y-2">
              <Label>{isPoster ? "Finished poster" : "Finished video"}</Label>
              <VideoUpload
                deliverableId={d.id}
                isPoster={isPoster}
                currentUrl={d.cloud_video_link}
                onUploaded={setEditedLink}
                // Only fires when the task had no caption, so this can't
                // discard something typed into the box a moment ago.
                onCaption={setCaption}
                onCaptioningChange={setAutoCaptioning}
                // We show it, next to the caption it is writing — so the
                // uploader must not show it too.
                onCaptionProgress={setCaptionNote}
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
