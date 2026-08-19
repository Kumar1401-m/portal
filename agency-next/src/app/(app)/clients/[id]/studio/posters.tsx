"use client";

import { useState, useTransition } from "react";
import { Loader2, ImagePlus, Plus, Lightbulb, Copy, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { POSTER_KINDS, posterKind, type PosterIdea } from "@/lib/content-kinds";
import { posterIdeasAction, posterCopyAction, posterToTaskAction } from "./actions";

type Copy = {
  headline: string;
  subtext: string;
  cta: string;
  visual: string;
  elements: string[];
  brief: string;
};

/**
 * Posters, written the way scripts are.
 *
 * The video side has had this for months — ideas, then the words, then onto
 * the board — and posters had a single "draft with AI" button on a task that
 * already existed. Which meant somebody had to have thought of the poster
 * first, and a month of posters thought of one at a time is a month of
 * offers and festival greetings.
 *
 * Two halves, in the order the work happens: what to make, then what goes on
 * it. Both carry the kind of poster, because that is what the loop records
 * against the task and measures the result by later.
 */
export function PostersPanel({ clientId }: { clientId: number }) {
  return (
    <div className="space-y-4">
      <PosterWriter clientId={clientId} />
      <PosterIdeas clientId={clientId} />
    </div>
  );
}

/* ------------------------------- the words ------------------------------- */

function PosterWriter({ clientId }: { clientId: number }) {
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState(POSTER_KINDS[0].key);
  const [occasion, setOccasion] = useState("");
  const [copy, setCopy] = useState<Copy | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  const k = posterKind(kind);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="p-topic">What is the poster about</Label>
            <Input
              id="p-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Diwali offer on the full body check-up"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-kind">Kind of poster</Label>
            <Select id="p-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {POSTER_KINDS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-occasion">Occasion (optional)</Label>
            <Input
              id="p-occasion"
              value={occasion}
              onChange={(e) => setOccasion(e.target.value)}
              placeholder="Diwali, 20 October"
            />
          </div>
          {/* What the chosen kind changes, said before it is generated rather
              than after — the picker is the decision, not the topic. */}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {k.what} <span className="text-foreground/70">{k.shape}</span>
          </p>
          <div className="sm:col-span-2">
            <Button
              type="button"
              disabled={pending || !topic.trim()}
              onClick={() =>
                start(async () => {
                  const res = await posterCopyAction(clientId, { topic, kind, occasion });
                  if (res.ok) setCopy(res.data as Copy);
                  else toast({ title: "Nothing came back", description: res.error, tone: "error" });
                })
              }
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="h-4 w-4" />
              )}
              {copy ? "Write another" : "Write the poster"}
            </Button>
          </div>
        </div>

        {copy ? (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Headline
              </p>
              <p className="text-xl font-semibold leading-tight">{copy.headline}</p>
            </div>
            {copy.subtext ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Supporting text
                </p>
                <p className="text-sm">{copy.subtext}</p>
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {copy.cta ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Call to action
                  </p>
                  <p className="text-sm">{copy.cta}</p>
                </div>
              ) : null}
              {copy.visual ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Visual
                  </p>
                  <p className="text-sm text-muted-foreground">{copy.visual}</p>
                </div>
              ) : null}
            </div>
            {copy.elements.length ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Also on it
                </p>
                <p className="text-sm text-muted-foreground">{copy.elements.join(" · ")}</p>
              </div>
            ) : null}

            <div className="flex flex-wrap justify-end gap-1">
              <CopyBriefButton text={copy.brief} />
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await posterToTaskAction(
                      clientId,
                      {
                        topic: topic.trim(),
                        kind,
                        kindLabel: k.label,
                        headline: copy.headline,
                        visual: copy.visual,
                        occasion,
                        why: "",
                      },
                      copy.brief
                    );
                    toast(
                      res.ok
                        ? {
                            title: "On the board",
                            description: "The designer has the brief on their dashboard.",
                          }
                        : { title: "Not created", description: res.error, tone: "error" }
                    );
                  })
                }
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                <Plus className="h-3.5 w-3.5" /> Make it a task
              </button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------- the ideas ------------------------------- */

function PosterIdeas({ clientId }: { clientId: number }) {
  const [ideas, setIdeas] = useState<PosterIdea[] | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Or ask what posters this client should be putting out.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await posterIdeasAction(clientId, 8);
              if (res.ok) setIdeas(res.data as PosterIdea[]);
              else toast({ title: "Nothing came back", description: res.error, tone: "error" });
            })
          }
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />}
          {ideas ? "More ideas" : "Poster ideas"}
        </button>
      </div>

      {ideas?.map((idea, i) => (
        <Card key={i}>
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium">{idea.topic}</p>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {idea.kindLabel}
              </span>
            </div>
            {idea.headline ? (
              <p className="rounded-md bg-muted/50 p-2 text-lg font-semibold leading-tight">
                {idea.headline}
              </p>
            ) : null}
            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {idea.visual ? <p>Visual: {idea.visual}</p> : null}
              {idea.occasion ? <p>For: {idea.occasion}</p> : null}
            </div>
            {idea.why ? (
              <p className="text-xs">
                <span className="font-medium">Why: </span>
                <span className="text-muted-foreground">{idea.why}</span>
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                disabled={adding !== null}
                onClick={() => {
                  setAdding(i);
                  posterToTaskAction(clientId, idea).then((res) => {
                    setAdding(null);
                    toast(
                      res.ok
                        ? { title: "On the board", description: "Ready for the designer." }
                        : { title: "Not created", description: res.error, tone: "error" }
                    );
                  });
                }}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                {adding === i ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Make it a task
              </button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CopyBriefButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* a browser that refuses the clipboard is not worth an error dialog */
        }
      }}
      className={buttonClasses({ variant: "ghost", size: "sm" })}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : "Copy the brief"}
    </button>
  );
}
