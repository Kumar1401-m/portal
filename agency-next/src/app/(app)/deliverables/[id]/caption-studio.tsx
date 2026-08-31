"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles, Copy, Check, Save, Loader2, Wand2 } from "lucide-react";
import { saveCaptionAction, type CaptionState } from "../actions";
import { finishAnalysisAfterUpload } from "../../editor/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * How many times the writer is asked "are you done yet".
 *
 * Twelve polls at two and a half seconds is thirty seconds of watching, which
 * is about what a dozen high-detail frames at high thinking takes. It stops
 * rather than spinning for ever: the job carries on server-side either way,
 * and a spinner with no end reads as a broken page.
 */
const CAPTION_POLLS = 12;

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      Save caption
    </Button>
  );
}

export function CaptionStudio({
  deliverableId,
  initialCaption,
  defaultLanguage,
  isPoster,
  hasVideo = false,
  locked = false,
}: {
  deliverableId: number;
  initialCaption: string;
  defaultLanguage: string;
  isPoster: boolean;
  /**
   * Whether there is a finished file to read.
   *
   * Decides one badge, and it is worth its own prop rather than a guess: a
   * caption written from the brief alone can read perfectly and still
   * describe a video nobody has made yet.
   */
  hasVideo?: boolean;
  /** The work is published; this is the record of it, not a draft. */
  locked?: boolean;
}) {
  const [genState, setGenState] = useState<CaptionState>({ ok: false });
  const [busy, startGen] = useTransition();
  /*
   * What it is doing right now, in one line.
   *
   * A caption takes the better part of a minute — a dozen frames read at the
   * highest thinking the portal buys — and a spinner that says nothing for
   * that long reads as a hung page. This says which step it is on, and it is
   * the ONLY thing on the screen that says anything about it: a button that
   * also narrates, plus a warning about long videos, plus this, is the same
   * sentence three times.
   */
  const [step, setStep] = useState<string | null>(null);

  /**
   * Run the caption writer, polling it as it goes.
   *
   * Polled rather than awaited in one call, and that is not only about the
   * message. The writer runs as several steps across most of a minute, and a
   * serverless function can be killed partway through any of them — in which
   * case a single long request returns nothing at all, having spent one of the
   * three regenerations this video gets in 48 hours. Each poll does what it
   * safely can and says whether more remains.
   */
  function generate(form: HTMLFormElement) {
    const fd = new FormData(form);
    // The selects above are choices for THIS caption, not settings on the
    // client — so they travel with the run rather than being saved anywhere.
    const overrides = {
      tone: String(fd.get("tone") || "") || undefined,
      language: String(fd.get("language") || "") || undefined,
      goal: String(fd.get("goal") || "") || undefined,
      length: String(fd.get("length") || "") || undefined,
      includeContact: fd.get("include_contact") !== null,
    };
    setStep("Starting…");
    startGen(async () => {
      for (let i = 0; i < CAPTION_POLLS; i++) {
        let res;
        try {
          res = await finishAnalysisAfterUpload(deliverableId, i === 0, overrides);
        } catch {
          setGenState({ ok: false, error: "Couldn't generate a caption." });
          setStep(null);
          return;
        }
        if (!res.ok) {
          setGenState({ ok: false, error: res.error || "Couldn't generate a caption." });
          setStep(null);
          return;
        }
        if (res.state === "done") {
          setGenState({
            ok: true,
            caption: res.caption ?? undefined,
            alternates: res.alternates,
            provider: "gemini",
            fromVideo: hasVideo,
          });
          setStep(null);
          return;
        }
        setStep(res.message ?? "Writing the caption…");
        if (!res.more) {
          setStep(null);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      setStep(null);
      setGenState({ ok: false, error: "Still working — reopen this page in a moment." });
    });
  }
  const [saveState, saveAction] = useActionState(saveCaptionAction, { ok: false });

  const [caption, setCaption] = useState(initialCaption);
  const [copied, setCopied] = useState(false);

  /*
   * When a fresh caption is generated, load it into the editor.
   *
   * Adjusted during render rather than from an effect. The editor's contents
   * are real state — they are typed in — so they cannot simply be derived from
   * the action's result; but "the action returned something new" is a change
   * this component can notice while rendering, and React re-runs immediately
   * without painting the stale value first. Doing it in an effect painted the
   * old caption for a frame and cost a second render every time.
   */
  const [seenGen, setSeenGen] = useState(genState);
  if (genState !== seenGen) {
    setSeenGen(genState);
    if (genState.ok && genState.caption) setCaption(genState.caption);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const providerLabel: Record<string, string> = {
    gemini: "Gemini",
    heuristic: "Draft (no AI key)",
  };

  /*
   * Once it is out, this is the record of what went out.
   *
   * The editor stayed open on a published reel, so a rewritten caption could
   * be saved over the one actually on Instagram — changing nothing there and
   * losing what was posted. Shown rather than hidden, because what the
   * caption said is worth reading back.
   */
  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Caption
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This went out with the post. It is kept as the record of what was published.
          </p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-mono text-[13px] leading-relaxed">
            {initialCaption || "No caption was saved."}
          </pre>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Caption Studio
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Options + generate */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            generate(e.currentTarget);
          }}
          className="space-y-4"
        >
          <input type="hidden" name="deliverable_id" value={deliverableId} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="language">Language</Label>
              <Select id="language" name="language" defaultValue={defaultLanguage}>
                <option value="English">English</option>
                <option value="Telugu">Telugu</option>
                <option value="Tenglish">Tenglish</option>
                <option value="Hindi">Hindi</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tone">Tone</Label>
              <Select id="tone" name="tone" defaultValue="Friendly">
                <option>Friendly</option>
                <option>Professional</option>
                <option>Playful</option>
                <option>Luxury</option>
                <option>Bold</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal">Goal</Label>
              <Select id="goal" name="goal" defaultValue="Engagement">
                <option>Engagement</option>
                <option>Sales</option>
                <option>Leads</option>
                <option>Appointments</option>
                <option>Awareness</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="length">Length</Label>
              <Select id="length" name="length" defaultValue="Medium">
                <option>Short</option>
                <option>Medium</option>
                <option>Long</option>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                name="include_contact"
                defaultChecked
                className="h-4 w-4 rounded border-input accent-[var(--primary)]"
              />
              Include contact details block
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Generate with AI
            </Button>
          </div>

          {/* One line, and only one. It says the step rather than repeating
              that something is happening — the spinner already said that. */}
          {step ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {step}
            </p>
          ) : null}
          {genState.error ? (
            <p className="text-sm text-destructive">{genState.error}</p>
          ) : null}
        </form>

        {/* Result editor */}
        <form action={saveAction} className="space-y-3">
          <input type="hidden" name="deliverable_id" value={deliverableId} />
          <div className="flex items-center justify-between">
            <Label htmlFor="caption">Caption</Label>
            <div className="flex items-center gap-2">
              {genState.ok && genState.provider ? (
                <Badge tone={genState.provider === "heuristic" ? "warning" : "success"}>
                  {providerLabel[genState.provider]}
                </Badge>
              ) : null}
              {/* Which source the copy came from. Worth its own badge: a
                  caption written from the brief alone can read perfectly and
                  still describe a video that was never made. */}
              {genState.ok ? (
                <Badge tone={genState.fromVideo ? "success" : "muted"}>
                  {genState.fromVideo ? "From the video" : "From the brief only"}
                </Badge>
              ) : null}
              {isPoster ? <Badge tone="info">Poster — clean caption</Badge> : null}
              <Button type="button" variant="ghost" size="sm" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <Textarea
            id="caption"
            name="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={14}
            className="font-mono text-[13px] leading-relaxed"
            placeholder="Generate a caption above, or write one here…"
          />
          <div className="flex items-center gap-3">
            <SaveButton />
            {saveState.ok ? (
              <span className="text-sm text-success">Saved ✓</span>
            ) : null}
          </div>
        </form>

        {/* Alternate styles (videos only) */}
        {genState.ok && genState.alternates && genState.alternates.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Alternate styles — click to load into the editor
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {genState.alternates.map((alt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCaption(alt)}
                  className="rounded-md border border-border bg-muted/40 p-3 text-left text-xs leading-relaxed text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted"
                >
                  <span className="mb-1 block font-medium text-foreground">
                    {["Professional", "Emotional", "Engagement", "Short", "Sales"][i] || `Style ${i + 1}`}
                  </span>
                  <span className="line-clamp-4 whitespace-pre-wrap">{alt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
