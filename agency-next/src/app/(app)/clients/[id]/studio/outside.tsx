"use client";

import { useState, useTransition, useEffect } from "react";
import { Loader2, Plus, Trash2, RefreshCw, Swords, MessageCircle, Check, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { KIND_LABEL, KINDS, type Kind, type SentimentBoard, type Gap, type Comparison } from "@/lib/comment-kinds";
import {
  rivalsAction,
  addRivalAction,
  removeRivalAction,
  refreshRivalsAction,
  gapsAction,
  commentsAction,
  readCommentsAction,
  handleCommentAction,
  themesAction,
} from "./outside-actions";

const num = (n: number | null) => (n === null ? "—" : new Intl.NumberFormat("en-IN").format(n));

/* ------------------------------- Rivals ------------------------------- */

/**
 * The accounts this client is measured against.
 *
 * Everything here comes through Meta's business discovery, which only reads
 * public Business and Creator accounts — so a handle that cannot be read says
 * exactly that on its row. An empty comparison that looks like a competitor
 * doing nothing would be the worst possible failure for this panel.
 */
export function RivalsPanel({ clientId }: { clientId: number }) {
  const [rows, setRows] = useState<(Comparison & { id: number })[] | null>(null);
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [handle, setHandle] = useState("");
  const [label, setLabel] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();

  useEffect(() => {
    rivalsAction(clientId).then((r) => {
      if (r.ok) setRows(r.data.rows);
    });
  }, [clientId]);

  const fail = (error: string) => toast({ title: "That didn't work", description: error, tone: "error", ack: true });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          <div className="min-w-40 flex-1 space-y-1.5">
            <Label htmlFor="r-handle">Instagram handle</Label>
            <Input
              id="r-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@theircliniс"
            />
          </div>
          <div className="min-w-32 flex-1 space-y-1.5">
            <Label htmlFor="r-label">What to call them</Label>
            <Input
              id="r-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="The clinic on MG Road"
            />
          </div>
          <Button
            type="button"
            disabled={pending || !handle.trim()}
            onClick={() =>
              start(async () => {
                const res = await addRivalAction(clientId, handle, label);
                if (!res.ok) return fail(res.error);
                setHandle("");
                setLabel("");
                const list = await rivalsAction(clientId);
                if (list.ok) setRows(list.data.rows);
              })
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
          {rows?.length ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await refreshRivalsAction(clientId);
                  if (res.ok) setRows(res.data.rows);
                  else fail(res.error);
                })
              }
              className={buttonClasses({ variant: "outline" })}
            >
              <RefreshCw className="h-4 w-4" /> Refresh all
            </button>
          ) : null}
        </CardContent>
      </Card>

      {rows === null ? null : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Swords className="h-7 w-7 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">
              Add the accounts this client actually competes with. Only public Business and Creator
              accounts can be read — that is Meta&apos;s rule, not ours, and a personal account will
              say so.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
                <div className="min-w-0">
                  <p className="font-medium">
                    @{r.handle}
                    {r.label ? (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">{r.label}</span>
                    ) : null}
                  </p>
                  {r.error ? (
                    <p className="mt-1 text-xs text-destructive">{r.error}</p>
                  ) : (
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                      {num(r.followers)} followers · {r.perWeek ?? "—"} posts a week ·{" "}
                      {num(r.avgEngagement)} avg likes+comments
                      {r.ratePerFollower !== null ? ` · ${r.ratePerFollower}% of followers` : ""}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`Remove @${r.handle}`}
                  onClick={() =>
                    start(async () => {
                      await removeRivalAction(clientId, r.id);
                      setRows((cur) => (cur ?? []).filter((x) => x.id !== r.id));
                    })
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </CardContent>
            </Card>
          ))}

          {/* Said once, under the numbers it applies to. */}
          <p className="px-1 text-xs text-muted-foreground">
            A rival&apos;s reach is not public, so their rate is against followers while this
            client&apos;s own is against reach. The two are not directly comparable — use the posting
            frequency and the gaps below instead.
          </p>

          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await gapsAction(clientId);
                if (res.ok) setGaps(res.data);
                else fail(res.error);
              })
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Swords className="h-4 w-4" />}
            What are they doing that we are not?
          </Button>

          {gaps?.map((g, i) => (
            <Card key={i}>
              <CardContent className="space-y-1.5 p-4">
                <p className="font-medium">{g.headline}</p>
                <p className="text-sm text-muted-foreground">{g.detail}</p>
                <p className="text-sm">
                  <span className="font-medium">Make this: </span>
                  {g.suggestion}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Comments ------------------------------ */

const KIND_TONE: Record<Kind, string> = {
  lead: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  complaint: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  question: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  negative: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  positive: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * What the comments are saying, and the two or three that need a person.
 *
 * The whole panel is built around `lead`: somebody asking the price under a
 * reel is a customer, and on a post with forty comments they are invisible.
 * A suggested reply is a draft to copy — nothing here posts to the client's
 * account, ever.
 */
export function CommentsPanel({ clientId }: { clientId: number }) {
  const [board, setBoard] = useState<SentimentBoard | null>(null);
  const [list, setThemes] = useState<string[] | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  useEffect(() => {
    commentsAction(clientId).then((r) => {
      if (r.ok) setBoard(r.data);
    });
  }, [clientId]);

  const fail = (error: string) => toast({ title: "That didn't work", description: error, tone: "error", ack: true });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await readCommentsAction(clientId);
              if (!res.ok) return fail(res.error);
              setBoard(res.data);
              toast({
                title: "Read the comments",
                description: `${res.data.added} new, ${res.data.classified} sorted.`,
              });
            })
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
          Read the latest comments
        </Button>
        {board && board.total > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await themesAction(clientId);
                if (res.ok) setThemes(res.data);
                else fail(res.error);
              })
            }
            className={buttonClasses({ variant: "outline" })}
          >
            What keeps coming up?
          </button>
        ) : null}
      </div>

      {board && board.total > 0 ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap gap-2 p-4">
              {KINDS.map((k) => (
                <span
                  key={k}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${KIND_TONE[k]}`}
                >
                  {KIND_LABEL[k]} {board.counts[k]}
                </span>
              ))}
              {board.unclassified ? (
                <span className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground">
                  {board.unclassified} not sorted yet
                </span>
              ) : null}
            </CardContent>
          </Card>

          {list?.length ? (
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What keeps coming up
                </p>
                {list.map((t, i) => (
                  <p key={i} className="text-sm">
                    · {t}
                  </p>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <div className="space-y-2">
            <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Needs a person ({board.needsAttention.length})
            </p>
            {board.needsAttention.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Nothing waiting — no unanswered questions, complaints or people asking to buy.
                </CardContent>
              </Card>
            ) : (
              board.needsAttention.map((c) => (
                <Card key={c.id}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 text-sm">
                        <span className="font-medium">@{c.username ?? "someone"}</span>{" "}
                        <span className="text-muted-foreground">{c.text}</span>
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          c.kind ? KIND_TONE[c.kind] : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {c.kind ? KIND_LABEL[c.kind] : "—"}
                      </span>
                    </div>

                    {c.suggestedReply ? (
                      <p className="rounded-md bg-muted/50 p-2 text-sm">
                        <span className="text-xs font-medium text-muted-foreground">Draft reply: </span>
                        {c.suggestedReply}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {c.permalink ? (
                        <a
                          href={c.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonClasses({ variant: "ghost", size: "sm" })}
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Open the post
                        </a>
                      ) : null}
                      {c.suggestedReply ? (
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(c.suggestedReply ?? "")}
                          className={buttonClasses({ variant: "ghost", size: "sm" })}
                        >
                          Copy reply
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          start(async () => {
                            await handleCommentAction(clientId, c.id, true);
                            setBoard((b) =>
                              b
                                ? { ...b, needsAttention: b.needsAttention.filter((x) => x.id !== c.id) }
                                : b
                            );
                          })
                        }
                        className={buttonClasses({ variant: "outline", size: "sm" })}
                      >
                        <Check className="h-3.5 w-3.5" /> Done
                      </button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* The line that keeps this safe: it drafts, a person sends. */}
          <p className="px-1 text-xs text-muted-foreground">
            Replies are drafts to copy. Nothing here is ever posted to the client&apos;s account.
          </p>
        </>
      ) : board ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageCircle className="h-7 w-7 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">
              No comments read yet. This works off the posts already synced in Analytics — press
              the button above and it pulls the comments on the last month of them.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
