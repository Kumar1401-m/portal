"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2, Send } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { draftPosterContentAction, sharePosterWithDesigner } from "./actions";

/**
 * The step that was missing: writing what goes on the poster, then handing it over.
 *
 * A poster used to be created as a title and a due date and then sat there —
 * the only thing that ever moved it to a designer was the content-approval
 * desk, and once that came out nothing did. So a designer never saw a submit
 * box, because the poster never reached their queue.
 *
 * AI drafts the copy from the client's brand knowledge; a person reads and
 * edits it; one button saves it and puts the poster in the designer's queue.
 * The draft is deliberately not saved on its own — a brief nobody has read is
 * how a client ends up seeing a line the agency never approved.
 */
export function PosterContentPanel({
  deliverableId,
  title,
  initialBrief,
}: {
  deliverableId: number;
  title: string;
  initialBrief: string;
}) {
  const [topic, setTopic] = useState(title);
  const [brief, setBrief] = useState(initialBrief);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Write what goes on this poster, then send it to the designer.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor={`t-${deliverableId}`} className="text-xs">
            What is it about
          </Label>
          <Input
            id={`t-${deliverableId}`}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="h-9 text-sm"
            placeholder="Diwali offer on full body check-up"
          />
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await draftPosterContentAction(deliverableId, topic);
              if (res.ok) setBrief(res.brief);
              else toast({ title: "Not drafted", description: res.error, tone: "error", ack: true });
            })
          }
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Draft with AI
        </button>
      </div>

      <form
        action={(fd) =>
          start(async () => {
            const res = await sharePosterWithDesigner({ ok: false }, fd);
            toast(
              res.ok
                ? { title: "Sent to the designer", description: "It is on their dashboard now." }
                : { title: "Not sent", description: res.error, tone: "error", ack: true }
            );
          })
        }
        className="space-y-2"
      >
        <input type="hidden" name="deliverable_id" value={deliverableId} />
        <Textarea
          name="brief"
          rows={6}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={"HEADLINE: …\nTEXT: …\nCALL TO ACTION: …\nVISUAL: …"}
          className="text-sm"
        />
        {/* Said here because it is the point of the gate: the words on a
            client's poster are the agency's responsibility, not the model's. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Read it before you send. Once sent, this is what the designer works from.
          </p>
          <Button type="submit" size="sm" disabled={pending || brief.trim().length < 10}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send to designer
          </Button>
        </div>
      </form>
    </div>
  );
}
