"use client";

import { useState, useTransition } from "react";
import {
  Loader2,
  Sparkles,
  RefreshCw,
  Save,
  Plus,
  Copy,
  Check,
  Lightbulb,
  FileText,
  ImageIcon,
  Search,
  CalendarRange,
  Swords,
  MessageCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  SCRIPT_LANGUAGES,
  CONTENT_TYPES,
  contentType,
  type ContentTypeKey,
  type Idea,
  type Script,
  type ScriptSection,
  type Strategy,
  type ThumbnailConcept,
  type SeoPack,
  countWords,
} from "@/lib/content-kinds";
import {
  strategyAction,
  ideasAction,
  scriptAction,
  regenerateSectionAction,
  saveScriptAction,
  thumbnailsAction,
  seoAction,
  ideaToTaskAction,
} from "./actions";
import { RivalsPanel, CommentsPanel } from "./outside";

type Tab = "strategy" | "ideas" | "script" | "thumbnail" | "seo" | "rivals" | "comments";

const TABS: { key: Tab; label: string; Icon: typeof Lightbulb }[] = [
  { key: "strategy", label: "Strategy", Icon: CalendarRange },
  { key: "ideas", label: "Ideas", Icon: Lightbulb },
  { key: "script", label: "Script", Icon: FileText },
  { key: "thumbnail", label: "Thumbnail", Icon: ImageIcon },
  { key: "seo", label: "SEO", Icon: Search },
  { key: "rivals", label: "Rivals", Icon: Swords },
  { key: "comments", label: "Comments", Icon: MessageCircle },
];

/**
 * Five tools over one brief.
 *
 * Tabs rather than five pages: they are the same job at different stages, and
 * somebody writing a script usually wants the thumbnail for it thirty seconds
 * later. Nothing is generated until asked — every one of these costs a model
 * call, and a page that fires five on load is a page nobody is allowed to open
 * twice.
 */
export function Studio({
  clientId,
  clientName,
  month,
  city,
  grounded,
  knowledgeFilled,
}: {
  clientId: number;
  clientName: string;
  month: string;
  city: string | null;
  /** Whether there is enough published history for the advice to be grounded. */
  grounded: boolean;
  knowledgeFilled: number;
}) {
  const [tab, setTab] = useState<Tab>("strategy");

  return (
    <div className="space-y-4">
      {/* Said once, at the top, because it applies to every tab: what these
          tools know is what somebody wrote down and what the account has
          actually published. */}
      {(!grounded || knowledgeFilled < 40) && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">These will be more specific once they have more to read</p>
            <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
              {!grounded ? (
                <li>
                  Not enough published history for this account yet — advice will be sensible for
                  the business, but not grounded in what has actually worked.
                </li>
              ) : null}
              {knowledgeFilled < 40 ? (
                <li>
                  Brand knowledge is {knowledgeFilled}% filled in. The words this client uses, and
                  the ones they never use, are on their page.
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <t.Icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "strategy" ? <StrategyPanel clientId={clientId} month={month} /> : null}
      {tab === "ideas" ? <IdeasPanel clientId={clientId} /> : null}
      {tab === "script" ? <ScriptPanel clientId={clientId} clientName={clientName} /> : null}
      {tab === "thumbnail" ? <ThumbnailPanel clientId={clientId} /> : null}
      {tab === "seo" ? <SeoPanel clientId={clientId} city={city} /> : null}
      {tab === "rivals" ? <RivalsPanel clientId={clientId} /> : null}
      {tab === "comments" ? <CommentsPanel clientId={clientId} /> : null}
    </div>
  );
}

/* --------------------------- shared bits --------------------------- */

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <Sparkles className="h-7 w-7 text-muted-foreground" />
        <p className="max-w-md text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
      {done ? "Copied" : label}
    </button>
  );
}

/**
 * Recount a script after a section has been edited or swapped.
 *
 * The clock is the whole point of the panel, so it cannot go stale the moment
 * somebody rewrites the hook — the counts under each heading have to be the
 * counts of what is on screen, not of the draft that first arrived.
 */
function remeasure(s: Script): Script {
  const segments = s.segments.map((seg) => ({ ...seg, words: countWords(s[seg.key]) }));
  const totalWords = segments.reduce((t, x) => t + x.words, 0);
  return {
    ...s,
    segments,
    totalWords,
    // Same floor the server used, so the warning does not flicker on and off
    // between a fresh draft and an edited one.
    short: totalWords < Math.round(s.targetWords * 0.85),
    full: [s.hook, s.body, s.cta].filter(Boolean).join("\n\n"),
  };
}

/** One place that turns a failed action into a toast, so every panel behaves alike. */
function useRunner() {
  const [pending, start] = useTransition();
  const toast = useToast();
  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onOk: (d: T) => void) =>
    start(async () => {
      const res = await fn();
      if (res.ok) onOk(res.data);
      else toast({ title: "Nothing came back", description: res.error, tone: "error", ack: true });
    });
  return { pending, run, toast };
}

/* ------------------------------ Strategy ------------------------------ */

function StrategyPanel({ clientId, month }: { clientId: number; month: string }) {
  const [data, setData] = useState<Strategy | null>(null);
  const { pending, run } = useRunner();

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => run<Strategy>(() => strategyAction(clientId, month) as never, setData)}
        className={buttonClasses({})}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {data ? "Plan it again" : `Plan ${month}`}
      </button>

      {!data && !pending ? (
        <Empty>
          The month&apos;s pillars, how often to post and in what formats — built from what this
          account has actually been rewarded for.
        </Empty>
      ) : null}

      {data ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            <p className="text-sm leading-relaxed">{data.summary}</p>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pillars
              </p>
              <div className="space-y-2">
                {data.pillars.map((p) => (
                  <div key={p.name} className="rounded-lg border border-border p-3">
                    <p className="flex items-baseline justify-between gap-3 text-sm font-medium">
                      {p.name}
                      <span className="shrink-0 tabular-nums text-muted-foreground">{p.share}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{p.why}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How often
                </p>
                <p className="mt-1 text-sm">{data.frequency}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Formats
                </p>
                <p className="mt-1 text-sm">{data.formats.join(", ")}</p>
              </div>
            </div>

            {data.postingPlan.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Week by week
                </p>
                <ul className="space-y-1 text-sm">
                  {data.postingPlan.map((w, i) => (
                    <li key={i}>· {w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {!data.grounded ? (
              <p className="text-xs text-muted-foreground">
                Not grounded in this account&apos;s own performance — there isn&apos;t enough
                published history yet. Treat it as a starting point, not a finding.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/* -------------------------------- Ideas -------------------------------- */

function IdeasPanel({ clientId }: { clientId: number }) {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [count, setCount] = useState(10);
  const { pending, run, toast } = useRunner();
  const [adding, setAdding] = useState<number | null>(null);

  const POTENTIAL: Record<string, string> = {
    high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    low: "bg-muted text-muted-foreground",
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="How many"
          value={String(count)}
          onChange={(e) => setCount(Number(e.target.value))}
          className="h-9 w-28 text-sm"
        >
          {[5, 10, 15, 20].map((n) => (
            <option key={n} value={n}>
              {n} ideas
            </option>
          ))}
        </Select>
        <button
          type="button"
          disabled={pending}
          onClick={() => run<Idea[]>(() => ideasAction(clientId, count) as never, setIdeas)}
          className={buttonClasses({})}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />}
          {ideas ? "More ideas" : "Generate ideas"}
        </button>
      </div>

      {!ideas && !pending ? (
        <Empty>
          Ideas that come with the reason they were suggested — and the reason is a number from
          this client&apos;s own account. Each one can go straight onto the board as a task.
        </Empty>
      ) : null}

      {ideas?.map((idea, i) => (
        <Card key={i}>
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium">{idea.topic}</p>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {idea.format}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    POTENTIAL[idea.potential] ?? POTENTIAL.medium
                  }`}
                >
                  {idea.potential} potential
                </span>
              </div>
            </div>

            <p className="rounded-md bg-muted/50 p-2 text-sm italic">&ldquo;{idea.hook}&rdquo;</p>

            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {idea.audience ? <p>For: {idea.audience}</p> : null}
              {idea.cta ? <p>CTA: {idea.cta}</p> : null}
            </div>

            {/* The reason is the whole difference between this and a topic
                generator, so it is not hidden behind a disclosure. */}
            {idea.why ? (
              <p className="text-xs">
                <span className="font-medium">Why: </span>
                <span className="text-muted-foreground">{idea.why}</span>
              </p>
            ) : null}

            <div className="flex justify-end gap-1">
              <CopyButton text={`${idea.topic}\n\n${idea.hook}\n\n${idea.cta}`} />
              <button
                type="button"
                disabled={adding === i}
                onClick={() => {
                  setAdding(i);
                  ideaToTaskAction(clientId, idea).then((res) => {
                    setAdding(null);
                    toast(
                      res.ok
                        ? { title: "Added to the board", description: `"${idea.topic}" is now a task.` }
                        : { title: "Not added", description: res.error, tone: "error" }
                    );
                  });
                }}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                {adding === i ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Make it a task
              </button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------- Script ------------------------------- */

function ScriptPanel({ clientId, clientName }: { clientId: number; clientName: string }) {
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<ContentTypeKey>("education");
  const [seconds, setSeconds] = useState(40);
  const [language, setLanguage] = useState<string>("English");
  const [platform, setPlatform] = useState("Instagram Reel");
  const [script, setScript] = useState<Script | null>(null);
  const [busySection, setBusySection] = useState<ScriptSection | null>(null);
  const { pending, run, toast } = useRunner();

  const input = { topic, seconds, language: language as never, platform, type };
  // The format decides the shape, the clock and the one thing the ending asks
  // for — so it is shown on screen rather than left to the prompt.
  const kind = contentType(type);

  // Straight off the script: which seconds each part owns and how long it
  // actually came back. A section list that ignored the clock is what let a
  // 60-second ask come back as 30 seconds without anything on screen saying so.
  const sections = script?.segments ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="s-topic">What is it about</Label>
            <Input
              id="s-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Why knee pain gets worse in winter"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="s-type">Kind of content</Label>
            <Select
              id="s-type"
              value={type}
              onChange={(e) => setType(e.target.value as ContentTypeKey)}
            >
              {/* Two groups, because the trending formats are borrowed from the
                  feed and go out of date — the first four do not. */}
              <optgroup label="The work">
                {CONTENT_TYPES.filter((t) => !t.trending).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Trending formats">
                {CONTENT_TYPES.filter((t) => t.trending).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {kind.what}{" "}
              <span className="text-foreground/70">
                Ends by asking for{" "}
                {kind.ask === "direct" ? "the enquiry itself" : `one thing — a ${kind.ask}`}.
              </span>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-len">Length</Label>
            <Select id="s-len" value={String(seconds)} onChange={(e) => setSeconds(Number(e.target.value))}>
              {[15, 30, 40, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} seconds
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-lang">Language</Label>
            <Select id="s-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {SCRIPT_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="s-plat">Platform</Label>
            <Select id="s-plat" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {["Instagram Reel", "YouTube Short", "Instagram Story", "YouTube video"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Button
              type="button"
              disabled={pending || !topic.trim()}
              onClick={() => run<Script>(() => scriptAction(clientId, input) as never, setScript)}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {script ? "Write another" : "Write the script"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {script ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-sm font-medium">
                {kind.label} · {seconds}s · <span className="tabular-nums">{script.totalWords}</span> words
              </p>
              {script.short ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Short of {script.targetWords} — write it again, or lengthen the body below.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Enough to fill {seconds} seconds.</p>
              )}
            </div>
            {sections.map((s) => (
              <div key={s.key} className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {s.label}
                    {/* The clock, on every section. A script is a timeline
                        before it is five paragraphs, and the seconds are what
                        the person holding the camera actually works to. */}
                    <span className="font-normal tabular-nums normal-case">
                      {s.from}–{s.to}s
                    </span>
                    <span
                      className={`font-normal tabular-nums normal-case ${
                        s.words < s.targetWords ? "text-amber-600 dark:text-amber-400" : ""
                      }`}
                      title={`${s.words} words, needs at least ${s.targetWords} for ${s.to - s.from} seconds`}
                    >
                      {s.words}/{s.targetWords} words
                    </span>
                  </p>
                  {/* One section at a time: regenerating the whole script to
                      fix an opening throws away four somebody approved. */}
                  <button
                    type="button"
                    disabled={busySection !== null}
                    onClick={() => {
                      setBusySection(s.key);
                      regenerateSectionAction(clientId, input, script, s.key).then((res) => {
                        setBusySection(null);
                        if (res.ok) setScript(remeasure({ ...script, [s.key]: res.data }));
                        else toast({ title: "Not rewritten", description: res.error, tone: "error" });
                      });
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={`Rewrite the ${s.label.toLowerCase()}`}
                    aria-label={`Rewrite the ${s.label.toLowerCase()}`}
                  >
                    {busySection === s.key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{script[s.key] || "—"}</p>
              </div>
            ))}

            {script.altHooks.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Other openings
                </p>
                <ul className="space-y-1">
                  {script.altHooks.map((h, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 text-sm">
                      <span className="italic">&ldquo;{h}&rdquo;</span>
                      <button
                        type="button"
                        onClick={() => setScript(remeasure({ ...script, hook: h }))}
                        className="shrink-0 text-xs text-primary hover:underline"
                      >
                        Use this
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap justify-end gap-1">
              <CopyButton
                text={
                  script.full ||
                  [script.hook, script.body, script.cta]
                    .filter(Boolean)
                    .join("\n\n")
                }
                label="Copy script"
              />
              <button
                type="button"
                onClick={() => {
                  const body =
                    script.full ||
                    [script.hook, script.body, script.cta]
                      .filter(Boolean)
                      .join("\n\n");
                  saveScriptAction(
                    clientId,
                    `${kind.label} — ${topic || clientName}`,
                    body,
                    platform
                  ).then((res) =>
                    toast(
                      res.ok
                        ? { title: "Saved to the script library" }
                        : { title: "Not saved", description: res.error, tone: "error" }
                    )
                  );
                }}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                <Save className="h-3.5 w-3.5" /> Save
              </button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!script && !pending ? (
        <Empty>
          Pick the kind of content first — an ad, a lesson and a myths reel are built differently and
          end by asking for different things. Hook, body and call to action, in English, Telugu or
          Tenglish. Any one section can be rewritten without touching the rest.
        </Empty>
      ) : null}
    </div>
  );
}

/* ----------------------------- Thumbnail ----------------------------- */

function ThumbnailPanel({ clientId }: { clientId: number }) {
  const [topic, setTopic] = useState("");
  const [concepts, setConcepts] = useState<ThumbnailConcept[] | null>(null);
  const { pending, run } = useRunner();

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="t-topic">What is the video about</Label>
            <Input
              id="t-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Why knee pain gets worse in winter"
            />
          </div>
          <Button
            type="button"
            disabled={pending || !topic.trim()}
            onClick={() => run<ThumbnailConcept[]>(() => thumbnailsAction(clientId, topic) as never, setConcepts)}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
            {concepts ? "More concepts" : "Get concepts"}
          </Button>
        </CardContent>
      </Card>

      {!concepts && !pending ? (
        <Empty>
          Three concepts a designer can build — the words on it, the expression, the layout and the
          palette, using this client&apos;s own brand colours.
        </Empty>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        {concepts?.map((c, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 p-4 text-sm">
              <p className="text-lg font-semibold leading-tight">{c.title}</p>
              <p className="text-xs text-muted-foreground">{c.hook}</p>
              <dl className="space-y-1 text-xs">
                <div>
                  <dt className="inline font-medium">Expression: </dt>
                  <dd className="inline text-muted-foreground">{c.expression}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Layout: </dt>
                  <dd className="inline text-muted-foreground">{c.layout}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Colours: </dt>
                  <dd className="inline text-muted-foreground">{c.colors}</dd>
                </div>
                {c.elements.length ? (
                  <div>
                    <dt className="inline font-medium">Also on it: </dt>
                    <dd className="inline text-muted-foreground">{c.elements.join(", ")}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="flex items-center justify-between pt-1">
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {c.aspect}
                </span>
                <CopyButton
                  text={`${c.title}\n${c.hook}\nExpression: ${c.expression}\nLayout: ${c.layout}\nColours: ${c.colors}`}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- SEO -------------------------------- */

/** Module scope, not inside the panel — a component created during render is
    remounted on every keystroke, and React 19's lint rule is right to refuse it. */
function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((k) => (
        <span key={k} className="rounded-full bg-muted px-2.5 py-1 text-xs">
          {k}
        </span>
      ))}
    </div>
  );
}

function SeoPanel({ clientId, city }: { clientId: number; city: string | null }) {
  const [topic, setTopic] = useState("");
  const [data, setData] = useState<SeoPack | null>(null);
  const { pending, run } = useRunner();

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="seo-topic">Subject to rank for</Label>
            <Input
              id="seo-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Physiotherapy for knee pain"
            />
          </div>
          <Button
            type="button"
            disabled={pending || !topic.trim()}
            onClick={() => run<SeoPack>(() => seoAction(clientId, topic, city ?? undefined) as never, setData)}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Get keywords
          </Button>
        </CardContent>
      </Card>

      {!data && !pending ? (
        <Empty>
          Keywords, titles and content clusters — with local searches kept separate, because
          &ldquo;best physiotherapist in {city || "your city"}&rdquo; is the one that ends in a
          phone call.
        </Empty>
      ) : null}

      {data ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            {data.localKeywords.length ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Local — the ones that end in a phone call
                </p>
                <Chips items={data.localKeywords} />
              </div>
            ) : null}
            {data.keywords.length ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  General
                </p>
                <Chips items={data.keywords} />
              </div>
            ) : null}
            {data.youtubeKeywords.length ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  YouTube
                </p>
                <Chips items={data.youtubeKeywords} />
              </div>
            ) : null}
            {data.titles.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Titles
                </p>
                <ul className="space-y-0.5 text-sm">
                  {data.titles.map((t) => (
                    <li key={t}>· {t}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {data.metaDescriptions.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Meta descriptions
                </p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.metaDescriptions.map((m) => (
                    <li key={m}>· {m}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {data.clusters.length ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Content clusters
                </p>
                <div className="space-y-2">
                  {data.clusters.map((c) => (
                    <div key={c.name} className="rounded-lg border border-border p-3">
                      <p className="text-sm font-medium">{c.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{c.topics.join(" · ")}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex justify-end">
              <CopyButton
                text={[...data.localKeywords, ...data.keywords].join(", ")}
                label="Copy keywords"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
