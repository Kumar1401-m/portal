import Link from "next/link";
import { ExternalLink, MessageSquareWarning } from "lucide-react";
import {
  getPosters,
  posterInReview,
  posterWithDesigner,
  posterAwaitingContent,
} from "@/lib/posters";
import type { SessionUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { PosterSubmitForm } from "../poster/poster-submit";
import { label, fmtDate } from "@/lib/utils";

/**
 * A designer's posters, with the box to submit each one.
 *
 * This is the Posters page, brought onto My work and stripped of everything
 * that was for somebody else. A designer had three screens that were mostly
 * each other: counts here, the same counts there, the same rows in both — and
 * only one of the two lists had the control that makes a list worth opening.
 * So there is one list now, on the page they land on, and it is the one with
 * the submit box.
 *
 * The Posters board itself is untouched for admins: theirs spans every client
 * and carries the approve-and-send step, which is not a designer's to press.
 */
export async function PosterQueue({ user }: { user: SessionUser }) {
  const posters = await getPosters(user);
  if (posters.length === 0) return null;

  /*
   * Three groups, and only the first is work.
   *
   * A poster starts as a brief the super admin writes and the client signs
   * off. Until that happens there is nothing to design, so it is not in the
   * to-do — it used to be, and a designer opening a poster with no copy in it
   * either waits or designs the wrong thing.
   *
   * Submitted work is kept visible behind the rest rather than hidden,
   * because "did that go through?" is a fair question.
   */
  const todo = posters.filter((p) => posterWithDesigner(p.status));
  const waiting = posters.filter((p) => posterInReview(p.status));
  const notYet = posters.filter((p) => posterAwaitingContent(p.status));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your posters</CardTitle>
        <p className="text-xs text-muted-foreground">
          {todo.length > 0
            ? `${todo.length} to design. Paste the link when each one is ready.`
            : notYet.length > 0
              ? "Nothing to design yet — the content for these is still being approved."
              : "Nothing left to design — everything is with the super admin."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {[...todo, ...waiting].map((p) => {
          const review = posterInReview(p.status);
          return (
            <div key={p.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/deliverables/${p.id}`}
                      className="font-medium hover:text-primary hover:underline"
                    >
                      {p.title}
                    </Link>
                    <Badge tone={statusTone(p.status)}>{label(p.status)}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.company_name}
                    {p.due_date ? ` · due ${fmtDate(p.due_date)}` : ""}
                  </p>
                </div>
                {p.edited_link ? (
                  <a
                    href={p.edited_link}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    <ExternalLink className="h-4 w-4" /> Open design
                  </a>
                ) : null}
              </div>

              {/* What they asked to be changed, in their words. The one thing
                  on this card that has to be read before anything is redone. */}
              {p.reject_reason ? (
                <div className="mt-3 flex items-start gap-2 rounded-md bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] p-3 text-sm">
                  <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <span className="font-medium text-destructive">Requested change: </span>
                    <span className="whitespace-pre-wrap">{p.reject_reason}</span>
                  </div>
                </div>
              ) : null}

              <div className="mt-3">
                {review ? (
                  <p className="text-sm text-muted-foreground">
                    Submitted — with the super admin for review.
                  </p>
                ) : (
                  <PosterSubmitForm deliverableId={p.id} currentLink={p.edited_link} />
                )}
              </div>
            </div>
          );
        })}

        {/* Coming, but not theirs yet. Named rather than hidden, so the month
            ahead is visible without looking like work that can be started. */}
        {notYet.length > 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            {notYet.length} more {notYet.length === 1 ? "poster is" : "posters are"} waiting on
            content approval. {notYet.length === 1 ? "It" : "They"} will appear here once the
            brief is signed off.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
