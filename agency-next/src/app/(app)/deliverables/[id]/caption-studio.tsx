"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles, Copy, Check, Save, Loader2, Wand2 } from "lucide-react";
import {
  generateCaptionAction,
  saveCaptionAction,
  type CaptionState,
} from "../actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Generating…
        </>
      ) : (
        <>
          <Wand2 className="h-4 w-4" /> Generate with AI
        </>
      )}
    </Button>
  );
}

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
}: {
  deliverableId: number;
  initialCaption: string;
  defaultLanguage: string;
  isPoster: boolean;
}) {
  const [genState, genAction] = useActionState<CaptionState, FormData>(
    generateCaptionAction,
    { ok: false }
  );
  const [saveState, saveAction] = useActionState(saveCaptionAction, { ok: false });

  const [caption, setCaption] = useState(initialCaption);
  const [copied, setCopied] = useState(false);

  // When a fresh caption is generated, load it into the editor.
  useEffect(() => {
    if (genState.ok && genState.caption) setCaption(genState.caption);
  }, [genState]);

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
    gemini: "Gemini AI",
    openai: "OpenAI",
    heuristic: "Draft (no AI key)",
  };

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
        <form action={genAction} className="space-y-4">
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
            <GenerateButton />
          </div>
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
