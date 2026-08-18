"use client";

import { useState, useTransition } from "react";
import { BookOpen, Loader2, ChevronDown, Ban, Megaphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { saveKnowledgeAction } from "./knowledge-actions";

export type KnowledgeForm = {
  clientId: number;
  audience: string;
  tone: string;
  brandColors: string;
  approvedTerms: string;
  bannedTerms: string;
  restrictions: string;
  ctas: string;
  notes: string;
  completeness: number;
};

/**
 * The brand, written down once so the AI stops guessing it.
 *
 * Closed until somebody opens it, but the summary line always shows how much
 * is filled in — an empty knowledge base is the reason captions come out
 * generic, and that connection is worth making on the page rather than in a
 * document nobody reads.
 *
 * Every field is optional and every one of them is plain text. A structured
 * editor for "words we never use" would be a nicer data model and a worse
 * place to type, and this gets filled in by somebody thinking about a client,
 * not about a schema.
 */
export function KnowledgeCard({ initial }: { initial: KnowledgeForm }) {
  const [open, setOpen] = useState(initial.completeness === 0);
  const [pending, start] = useTransition();
  const toast = useToast();

  const submit = (fd: FormData) =>
    start(async () => {
      const res = await saveKnowledgeAction({ ok: false }, fd);
      toast({
        title: res.ok ? (res.message ?? "Saved.") : (res.error ?? "Could not save it."),
        tone: res.ok ? undefined : "error",
        ack: !res.ok,
      });
    });

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <BookOpen className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold leading-none tracking-tight">Brand knowledge</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {initial.completeness === 0
              ? "Nothing written down yet — this is why captions come out generic"
              : `${initial.completeness}% filled in. Every caption, script and idea reads it.`}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <form action={submit} className="border-t border-border">
          <input type="hidden" name="client_id" value={initial.clientId} />

          <CardContent className="space-y-4 p-5">
            <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="k-audience">Who the content is for</Label>
                <Input
                  id="k-audience"
                  name="audience"
                  defaultValue={initial.audience}
                  placeholder="Families in Vijayawada, 30–55, looking for a physiotherapist"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-tone">How it should sound</Label>
                <Input
                  id="k-tone"
                  name="tone"
                  defaultValue={initial.tone}
                  placeholder="Warm, plain Telugu, never salesy"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-colors">Brand colours</Label>
                <Input
                  id="k-colors"
                  name="brand_colors"
                  defaultValue={initial.brandColors}
                  placeholder="#0B6E4F bottle green, cream"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-terms">Words they use</Label>
                <Textarea
                  id="k-terms"
                  name="approved_terms"
                  rows={3}
                  defaultValue={initial.approvedTerms}
                  placeholder={"One per line\nclients (never customers)\nconsultation"}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-banned" className="flex items-center gap-1.5">
                  <Ban className="h-3.5 w-3.5 text-destructive" /> Words never to use
                </Label>
                <Textarea
                  id="k-banned"
                  name="banned_terms"
                  rows={3}
                  defaultValue={initial.bannedTerms}
                  placeholder={"One per line\ncure\nguaranteed\ncheap"}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-restrictions">Rules</Label>
                <Textarea
                  id="k-restrictions"
                  name="restrictions"
                  rows={3}
                  defaultValue={initial.restrictions}
                  placeholder={"One per line\nNever promise a treatment outcome\nNo prices in captions"}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="k-ctas" className="flex items-center gap-1.5">
                  <Megaphone className="h-3.5 w-3.5 text-muted-foreground" /> Their calls to action
                </Label>
                <Textarea
                  id="k-ctas"
                  name="ctas"
                  rows={3}
                  defaultValue={initial.ctas}
                  placeholder={"One per line\nWhatsApp us on 98765 43210\nBook a slot — link in bio"}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="k-notes">Anything else worth knowing</Label>
                <Textarea
                  id="k-notes"
                  name="notes"
                  rows={2}
                  defaultValue={initial.notes}
                  placeholder="The doctor's name is Dr Priya, always with the qualification after it."
                />
              </div>
            </div>

            {/* Said here rather than in a tooltip, because it is the reason to
                bother filling any of it in. */}
            <p className="text-xs text-muted-foreground">
              The words and rules are handed to the AI as requirements, not suggestions — the same
              way a caption template is. Everything else is offered as background it may use.
            </p>
          </CardContent>

          <div className="flex justify-end border-t border-border p-4">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save brand knowledge
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
