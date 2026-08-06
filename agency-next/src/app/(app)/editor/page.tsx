import Link from "next/link";
import {
  Clapperboard,
  Sparkles,
  Play,
  CalendarClock,
  MessageSquareWarning,
  Film,
} from "lucide-react";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import {
  getEditorQueue,
  getStageCounts,
  getEditors,
  EDITOR_STAGES,
  type EditorStage,
} from "@/lib/editor-queue";
import { videoAiReady } from "@/lib/video-ai";
import { CaptionCatchUp } from "./catch-up";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { buttonClasses } from "@/components/ui/button";
import { cn, fmtDate, label } from "@/lib/utils";

export const metadata = { title: "Editing · NVK Hub" };
export const dynamic = "force-dynamic";

const isStage = (v: unknown): v is EditorStage =>
  EDITOR_STAGES.some((s) => s.key === v);

/** How overdue something is, said the way a person would. */
function due(dateStr: string | null): { text: string; tone: string } {
  if (!dateStr) return { text: "No date", tone: "text-muted-foreground" };
  const d = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date();
  const days = Math.round(
    (d.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000
  );
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: "text-destructive font-medium" };
  if (days === 0) return { text: "Due today", tone: "text-warning font-medium" };
  if (days === 1) return { text: "Due tomorrow", tone: "text-warning" };
  return { text: fmtDate(dateStr), tone: "text-muted-foreground" };
}

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; editor?: string; client?: string }>;
}) {
  const user = await requireUser(STAFF_ROLES);
  const sp = await searchParams;

  const stage = isStage(sp.stage) ? sp.stage : null;
  const editorId = Number(sp.editor) || null;
  const clientId = Number(sp.client) || null;
  const allowedClientIds = await crmClientIds(user);

  const filters = { stage, assignedTo: editorId, clientId, allowedClientIds };

  const [tasks, counts, editors, clients, aiReady] = await Promise.all([
    getEditorQueue(filters),
    getStageCounts(filters),
    getEditors(),
    getClientsMini(allowedClientIds),
    videoAiReady(),
  ]);

  const qs = (patch: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged = { stage, editor: editorId, client: clientId, ...patch };
    if (merged.stage) p.set("stage", String(merged.stage));
    if (merged.editor) p.set("editor", String(merged.editor));
    if (merged.client) p.set("client", String(merged.client));
    const s = p.toString();
    return s ? `/editor?${s}` : "/editor";
  };

  return (
    <div className="space-y-5">
      {/* Renders nothing; finishes any caption left mid-flight. */}
      {aiReady ? <CaptionCatchUp /> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Clapperboard className="h-6 w-6 text-primary" />
            Editing
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every video still on an editor&apos;s plate, in the order it needs attention.
            {aiReady ? " Upload a cut and the AI writes the caption from what it sees." : ""}
          </p>
        </div>
        {/* Creating work is the account team's job — the form behind this
            would bounce an editor straight back here. */}
        {user.role === "video_editor" ? null : (
          <Link href="/deliverables/new" className={buttonClasses({ variant: "secondary", size: "sm" })}>
            New task
          </Link>
        )}
      </div>

      {/* Stage tabs — the pipeline, in the order work actually moves. */}
      <div className="flex flex-wrap gap-2 border-b border-border">
        <Link
          href={qs({ stage: null })}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            !stage ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          All open
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{counts.all}</span>
        </Link>
        {EDITOR_STAGES.map((s) => (
          <Link
            key={s.key}
            href={qs({ stage: s.key })}
            title={s.hint}
            className={cn(
              "flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              stage === s.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
              {counts[s.key]}
            </span>
          </Link>
        ))}
      </div>

      {/* One filter row, above everything it scopes. */}
      <form method="GET" action="/editor" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        {stage ? <input type="hidden" name="stage" value={stage} /> : null}
        <Select name="editor" defaultValue={editorId ? String(editorId) : ""} aria-label="Editor" className="h-9 w-44 text-sm">
          <option value="">Anyone</option>
          {editors.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>
        <Select name="client" defaultValue={clientId ? String(clientId) : ""} aria-label="Client" className="h-9 w-44 text-sm">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.company_name}</option>
          ))}
        </Select>
        <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          Apply
        </button>
        {/* One click to the only question most people open this page to ask.
            The dropdown could already do it, but it means finding your own
            name in a list of everyone. */}
        <Link
          href={qs({ editor: editorId === user.id ? null : user.id })}
          className={buttonClasses({
            variant: editorId === user.id ? "default" : "ghost",
            size: "sm",
          })}
        >
          My tasks
        </Link>
        {editorId || clientId ? (
          <Link href={qs({ editor: null, client: null })} className={buttonClasses({ variant: "ghost", size: "sm" })}>
            Clear
          </Link>
        ) : null}
      </form>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing here. Either everything is done, or the filters are too narrow.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tasks.map((t) => {
            const d = due(t.due_date);
            const needsAttention = t.status === "changes_requested";

            return (
              <Card
                key={t.id}
                className={cn(needsAttention && "border-[color-mix(in_srgb,var(--warning)_35%,var(--border))]")}
              >
                <CardContent className="flex flex-wrap items-start gap-4 p-4">
                  {/* Thumbnail slot — a play affordance when there's a cut to watch. */}
                  <Link
                    href={`/deliverables/${t.id}`}
                    className="grid h-16 w-24 shrink-0 place-items-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                    aria-label={`Open ${t.title}`}
                  >
                    {t.video_link ? <Play className="h-5 w-5" /> : <Film className="h-5 w-5 opacity-50" />}
                  </Link>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/deliverables/${t.id}`} className="font-medium hover:text-primary">
                        {t.title}
                      </Link>
                      <Badge tone={statusTone(t.status)}>{label(t.status)}</Badge>
                      {t.priority === "urgent" || t.priority === "high" ? (
                        <Badge tone="danger">{label(t.priority)}</Badge>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{t.company_name}</span>
                      <span className={d.tone}>
                        <CalendarClock className="mr-1 inline h-3 w-3" />
                        {d.text}
                      </span>
                      {t.assignee_name ? <span>· {t.assignee_name}</span> : <span>· unassigned</span>}
                      {t.content_category ? <span>· {t.content_category}</span> : null}
                    </div>

                    {/* The client's own words, when they've asked for changes —
                        the single most important thing on the card. */}
                    {needsAttention && t.reject_reason ? (
                      <p className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
                        <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="line-clamp-2">{t.reject_reason}</span>
                      </p>
                    ) : null}

                    {t.ai_state === "done" && t.ai_caption ? (
                      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="line-clamp-1">
                          AI caption ready
                          {t.ai_language ? ` (${t.ai_language})` : ""} — {t.ai_caption.slice(0, 70)}…
                        </span>
                      </p>
                    ) : t.ai_state && !["done", "failed"].includes(t.ai_state) ? (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
                        AI is watching the video…
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col gap-1.5">
                    <Link href={`/deliverables/${t.id}`} className={buttonClasses({ size: "sm" })}>
                      Open
                    </Link>
                    {t.video_link ? (
                      <a
                        href={t.video_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses({ variant: "ghost", size: "sm" })}
                      >
                        Watch
                      </a>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
