import Link from "next/link";
import { PartyPopper, Info } from "lucide-react";
import type { BoardEmptyReason } from "@/lib/deliverables";

/**
 * What an empty board says.
 *
 * "You're all caught up" is true when there is nothing, and misleading when
 * there are tasks the board's filter happens to exclude — dated later, never
 * dated, or belonging to a client who has been archived. Somebody who has just
 * created sixteen tasks and sees a party emoji has been told the opposite of
 * what is happening, with nothing to act on.
 *
 * So: celebrate only a genuinely empty book, and otherwise name what exists
 * and where it went.
 */
export function EmptyBoard({
  reason,
  filtered,
  boardLabel = "due",
}: {
  reason: BoardEmptyReason;
  filtered: boolean;
  boardLabel?: string;
}) {
  const elsewhere = reason.later + reason.undated + reason.archivedClient + reason.noClient;

  if (filtered) {
    return (
      <p className="p-10 text-center text-sm text-muted-foreground">
        Nothing {boardLabel} in this view — try clearing the filters.
      </p>
    );
  }

  if (elsewhere === 0) {
    return (
      <p className="flex items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
        Nothing {boardLabel} — you&apos;re all caught up.
        <PartyPopper className="h-4 w-4" />
      </p>
    );
  }

  const bits: React.ReactNode[] = [];
  if (reason.later) {
    bits.push(
      <li key="later">
        <b className="tabular-nums text-foreground">{reason.later}</b> dated later — they appear
        here on the day they are due.
      </li>
    );
  }
  if (reason.undated) {
    bits.push(
      <li key="undated">
        <b className="tabular-nums text-foreground">{reason.undated}</b> with no due date, so no
        board can place them. Set a date on the client&apos;s monthly plan.
      </li>
    );
  }
  if (reason.archivedClient) {
    bits.push(
      <li key="archived">
        <b className="tabular-nums text-foreground">{reason.archivedClient}</b> belonging to an
        archived client, which the portal hides everywhere.
      </li>
    );
  }
  if (reason.noClient) {
    bits.push(
      <li key="orphan">
        <b className="tabular-nums text-foreground">{reason.noClient}</b> whose client record is
        gone entirely.
      </li>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-2 p-10 text-center text-sm">
      <p className="flex items-center justify-center gap-2 font-medium">
        <Info className="h-4 w-4 text-muted-foreground" />
        Nothing {boardLabel} today.
      </p>
      <p className="text-muted-foreground">But there is work here — it is just not due yet:</p>
      <ul className="space-y-1 text-left text-xs text-muted-foreground">{bits}</ul>
      <p className="text-xs text-muted-foreground">
        <Link href="/deliverables" className="text-primary hover:underline">
          See every task
        </Link>
        {reason.live ? ` · ${reason.live} in total` : ""}
      </p>
    </div>
  );
}
