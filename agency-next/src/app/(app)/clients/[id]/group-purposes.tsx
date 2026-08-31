"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Check, MessageCircle, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveGroupPurposesAction, type PurposeState } from "./group-actions";

/**
 * `off` is why this client is not sent this kind of message at all — set from
 * the switches on their edit page. Ticking a group for something that is
 * switched off would otherwise read as "this will go here", and it won't.
 */
export type PurposeOption = { key: string; label: string; blurb: string; off?: string | null };
export type GroupRow = { groupId: string; name: string | null; on: string[] };

/**
 * What each of this client's WhatsApp groups is used for.
 *
 * Here rather than in Settings because it is a fact about this client — who
 * of theirs sits in which chat — and the person who knows it is the one
 * looking at their page, not an admin scrolling a list of every group the
 * agency has.
 */
export function GroupPurposes({
  clientId,
  groups,
  purposes,
  /** The purposes this database can store — see `storablePurposes`. */
  storable,
}: {
  clientId: number;
  groups: GroupRow[];
  purposes: PurposeOption[];
  storable: string[];
}) {
  const notReady = purposes.filter((p) => !storable.includes(p.key));

  /*
   * With one group there is nothing to choose between.
   *
   * This card answers "which of their groups gets what". A client with a
   * single group has exactly one answer to that, so every tick on it changes
   * nothing — the purposes *order* groups rather than filter them, and there
   * is nothing to order. Six controls that do nothing, sitting above a card
   * that does, teaches somebody that neither of them works.
   *
   * It reappears the moment a second group is linked, which is the case it was
   * built for: approvers in one chat, accounts in another.
   *
   * Zero groups is a different thing and still worth saying — nothing can
   * reach that client at all — so that case falls through to the card below.
   */
  if (groups.length === 1) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          WhatsApp groups
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No group linked yet. Add one under Settings → WhatsApp, and it will appear here.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Tick what each group is for. A client whose approvers and accounts team sit in
              different chats gets each message in the right one. Whether we send a kind of
              message <em>at all</em> is on{" "}
              <Link href={`/clients/${clientId}/edit`} className="underline">
                their edit page
              </Link>
              .
            </p>
            {notReady.length ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>
                  <b>{notReady.map((p) => p.label).join(", ")}</b> cannot be saved yet — those
                  columns are not applied, so unticking them will not stick. Run{" "}
                  <b>Settings → Database → Apply</b>, then come back.
                </span>
              </p>
            ) : null}
            {groups.map((g) => (
              <GroupForm key={g.groupId} group={g} purposes={purposes} storable={storable} />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GroupForm({
  group,
  purposes,
  storable,
}: {
  group: GroupRow;
  purposes: PurposeOption[];
  storable: string[];
}) {
  const [state, action] = useActionState<PurposeState, FormData>(saveGroupPurposesAction, {});

  return (
    <form action={action} className="space-y-2 rounded-lg border border-border p-3">
      <input type="hidden" name="group_id" value={group.groupId} />

      <p className="text-sm font-medium">
        {group.name || (
          <span
            className="text-muted-foreground"
            title="We learn a group's name from the first message it sends. The link works either way — approvals are matched on the group id."
          >
            name will appear on their first message
          </span>
        )}
      </p>

      <div className="space-y-1.5">
        {purposes.map((p) => (
          <label
            key={p.key}
            htmlFor={`${group.groupId}-${p.key}`}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
          >
            <input
              id={`${group.groupId}-${p.key}`}
              type="checkbox"
              name={`p_${p.key}`}
              value="1"
              defaultChecked={group.on.includes(p.key)}
              disabled={!storable.includes(p.key)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
            />
            <span className="text-xs leading-snug">
              <span className={p.off ? "font-medium text-muted-foreground line-through" : "font-medium"}>
                {p.label}
              </span>
              <br />
              <span className="text-muted-foreground">{p.off ?? p.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <SubmitButton variant="secondary" size="sm">
          Save
        </SubmitButton>
        {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
        {state.ok ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" /> {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
