"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { SquarePen, Loader2, Send, Wand2 } from "lucide-react";
import {
  updateVideoDetails,
  generateCaptionAction,
  type VideoDetailsState,
} from "./actions";
import type { DeliverableListRow } from "@/lib/deliverables";
import { serviceOf } from "@/lib/services";
import { Modal } from "@/components/ui/modal";
import {
  ServiceCategoryPicker,
  type CategoryOptions,
} from "@/components/admin/service-category-picker";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function EditVideoModal({
  deliverable: d,
  categories,
  canSendToClient,
}: {
  deliverable: DeliverableListRow;
  categories: CategoryOptions;
  canSendToClient: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<VideoDetailsState, FormData>(updateVideoDetails, {
    ok: false,
  });

  const [caption, setCaption] = useState(d.caption ?? "");
  const [genPending, startGen] = useTransition();
  const [genError, setGenError] = useState<string | null>(null);

  // Reset the caption editor to the latest saved value each time the modal opens.
  useEffect(() => {
    if (open) {
      setCaption(d.caption ?? "");
      setGenError(null);
    }
  }, [open, d.caption]);

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
        <SquarePen className="h-4 w-4" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Update Task Details">
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
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`t-${d.id}`}>Title</Label>
              <Input id={`t-${d.id}`} name="title" defaultValue={d.title} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`ch-${d.id}`}>Content in Video</Label>
              <Textarea id={`ch-${d.id}`} name="content_hook" rows={2} defaultValue={d.content_hook ?? ""} />
            </div>

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

            <div className="space-y-1.5">
              <Label htmlFor={`el-${d.id}`}>
                Deliverable Link <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`el-${d.id}`}
                name="edited_link"
                placeholder="Drive / YouTube / Canva / staging link"
                defaultValue={d.edited_link ?? ""}
              />
            </div>

            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
            <Button type="button" variant="destructive" onClick={() => setOpen(false)}>
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
