"use client";

import { useState, useTransition } from "react";
import { Pencil, Loader2, Send, Wand2, Trash2 } from "lucide-react";
import {
  updateVideoDetails,
  generateCaptionAction,
  type VideoDetailsState,
} from "./actions";
import type { DeliverableListRow } from "@/lib/deliverables";
import { serviceOf, type ServiceKey } from "@/lib/services";
import { Modal } from "@/components/ui/modal";
import { VideoUpload, CaptionLine, type CaptionNote } from "./video-upload";
import { useToast } from "@/components/ui/toast";
import { deleteDeliverable } from "./upload-actions";
import { finishAnalysisAfterUpload } from "../editor/actions";

/**
 * How many times the video writer is asked "are you done yet".
 *
 * Twelve polls at two and a half seconds is thirty seconds of watching, which
 * is about what a dozen high-detail frames at high reasoning effort takes. It
 * stops rather than spinning forever: the job carries on server-side either
 * way, and a spinner that never ends reads as a broken page.
 */
const CAPTION_POLLS = 12;
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

  const [caption, setCaption] = useState(d.caption ?? "");
  const [editedLink, setEditedLink] = useState(d.edited_link ?? "");
  // A poster brief is written as one block of copy, so the fields follow the
  // service picker live rather than the value the task was saved with.
  const [service, setService] = useState<ServiceKey>(serviceOf(d));
  const isPoster = service === "poster_designing";
  /** What the send actually requires — see the Send To Approval button below. */
  const canSend = isPoster || Boolean(caption.trim());
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
  /*
   * Captions left inside the 48-hour window, once a run has reported it.
   *
   * Null until then rather than assumed full: the count lives on the analysis
   * row and reading it for every task in a list would be a query per row, for
   * a number most people never look at.
   */
  const [left, setLeft] = useState<number | null>(null);
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

  /**
   * Write the caption, using whichever writer can actually see the work.
   *
   * There are two, and they are not equal. The video writer reads a dozen
   * frames of the finished cut at the highest reasoning effort the portal
   * buys, hears the transcript, and reproduces the client's agreed caption
   * structure. The brief writer reads what somebody typed weeks ago. This
   * button used to always call the second one — even on a task with the
   * finished video sitting right under it — so "Generate with AI" produced
   * a caption about the plan rather than about the reel, and ignored the
   * structure entirely.
   *
   * So: a video goes to the video writer, and everything else (a poster, a
   * task with nothing uploaded yet) keeps the brief writer, which is the only
   * thing it could use anyway.
   */
  function generate() {
    setCaptionNote({ text: "Writing a caption…", tone: "busy" });
    startGen(async () => {
      if (!isPoster && (d.cloud_video_link || d.edited_link)) {
        await fromVideo();
        return;
      }

      const fd = new FormData();
      fd.set("deliverable_id", String(d.id));
      const res = await generateCaptionAction({ ok: false }, fd);
      if (res.ok && res.caption) {
        setCaption(res.caption);
        setCaptionNote({
          text: isPoster
            ? "Written from the brief."
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

  /**
   * The video writer, which takes about half a minute and reports as it goes.
   *
   * Polled rather than awaited in one call: it runs as several steps and a
   * serverless function can be killed partway through any of them, so each
   * call does what it safely can and says whether more remains.
   */
  async function fromVideo() {
    for (let i = 0; i < CAPTION_POLLS; i++) {
      let res;
      try {
        // Forced on the first pass only: the rest of the loop is polling the
        // job it just started, and forcing again would restart it each time.
        res = await finishAnalysisAfterUpload(d.id, i === 0);
      } catch {
        setCaptionNote({ text: "Couldn't generate a caption.", tone: "error" });
        return;
      }

      if (typeof res.left === "number") setLeft(res.left);

      if (!res.ok) {
        setCaptionNote({ text: res.error || "Couldn't generate a caption.", tone: "error" });
        return;
      }
      if (res.state === "done") {
        if (res.caption) setCaption(res.caption);
        setCaptionNote({ text: "Written from the video.", tone: "done" });
        return;
      }

      setCaptionNote({ text: res.message ?? "Writing the caption…", tone: "busy" });
      if (!res.more) return;
      await new Promise((r) => setTimeout(r, 2500));
    }
    setCaptionNote({ text: "Still working — reopen this in a moment.", tone: "busy" });
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
        {/*
          The raw-footage form used to sit here, above the details.

          Taking it out of this modal does not remove the stage: footage still
          arrives from the client's WhatsApp group, the chase reminders still
          go out, and a task is still moved on from the workflow controls on
          the task page. What is gone is a second, quieter place to do it —
          this modal is for a task's details, and a form that changed the
          task's status from inside it was a different job wearing the same
          button.
        */}
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
                  disabled={captioning || left === 0}
                  /* The primary action of this panel, and it did not look like
                     one — a grey button beside an empty box reads as optional. */
                  className={buttonClasses({ variant: "default", size: "sm" })}
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

              {/*
                What a regenerate costs, said before it is spent.
                
                Reading a dozen high-detail frames at the highest reasoning
                effort the portal buys is the most expensive call it makes, and
                the button beside this invites pressing it again. Three is
                enough to get one reel's copy right; a fourth in two days is
                hoping a different answer falls out of the same video, and the
                cure for that is the caption structure on the client, not
                paying again.

                Shown for a video only — a poster is written from its brief by
                a different, much cheaper writer, and is not limited.
              */}
              {!isPoster && (d.cloud_video_link || d.edited_link) ? (
                <p
                  className={
                    left === 0
                      ? "rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                      : "rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
                  }
                >
                  {left === null
                    ? "Regenerate: 3 times per video, per 48 hours."
                    : left === 0
                      ? "No regenerations left for 48 hours — edit the caption here instead."
                      : `${left} of 3 regenerations left in this 48 hours.`}
                </p>
              ) : null}
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
              /*
               * Dark and dead until there is a caption to send.
               *
               * A post is the video and its words together. Sent without them
               * the client approves a clip, and the copy that publishes
               * underneath it on their feed is copy they were never shown —
               * and nothing about the send would have looked wrong.
               *
               * Left orange and merely refused on the press, it reads as a
               * broken button. Greyed, it reads as a step that has not
               * happened yet, which is exactly what it is.
               */
              <button
                type="submit"
                name="mode"
                value="approval"
                /*
                 * A poster has no caption to wait for — the words are on the
                 * design. Greying the button on one left every poster with a
                 * dead Send and a tooltip asking for a caption that no part of
                 * this portal would ever have written.
                 */
                disabled={pending || !canSend}
                title={canSend ? undefined : "Generate or write the caption first"}
                className={buttonClasses(canSend ? {} : { variant: "secondary", className: "opacity-60" })}
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
