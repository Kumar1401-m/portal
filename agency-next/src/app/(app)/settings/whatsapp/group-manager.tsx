"use client";

import { useActionState } from "react";
import { Link2, Unlink, Loader2, Check, TriangleAlert, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { buttonClasses } from "@/components/ui/button";
import { linkGroupAction, unlinkGroupAction, type GroupState } from "../../approvals/whatsapp-actions";
import type { WhatsAppGroup, DiscoveredGroup } from "@/lib/whatsapp-approvals";
import type { ClientMini } from "@/lib/deliverables";

export type ServiceGroup = { groupId: string; name: string | null; participants: number | null };

/**
 * Mapping WhatsApp groups to clients.
 *
 * This mapping is what makes an inbound "APPROVE V245" attributable, and it's
 * also the guard that stops one client approving another's video by typing its
 * code — so groups are picked from the live list the account is actually in,
 * never typed by hand. A mistyped group id would silently accept nothing.
 */
export function GroupManager({
  linked,
  available,
  discovered,
  clients,
  serviceReachable,
  listWarning,
}: {
  linked: WhatsAppGroup[];
  available: ServiceGroup[];
  /** Groups seen in inbound messages — the fallback when the picker can't enumerate. */
  discovered: DiscoveredGroup[];
  clients: ClientMini[];
  serviceReachable: boolean;
  listWarning?: string | null;
}) {
  const [linkState, linkAction, linking] = useActionState<GroupState, FormData>(
    linkGroupAction,
    { ok: false }
  );
  const [unlinkState, unlinkAction, unlinking] = useActionState<GroupState, FormData>(
    unlinkGroupAction,
    { ok: false }
  );

  const linkedIds = new Set(linked.map((g) => g.group_id));

  /*
   * Two sources merged into one picker.
   *
   * `available` is WhatsApp's own chat list — complete when it works, but it
   * runs library code inside the WhatsApp Web page and breaks on a version
   * skew. `discovered` comes from messages that actually arrived, so it needs
   * nothing from WhatsApp's internals and doubles as proof the inbound path
   * works for that group.
   */
  const seen = new Set<string>();
  const unlinkedGroups: (ServiceGroup & { fromMessages?: boolean })[] = [];

  for (const g of available) {
    if (linkedIds.has(g.groupId) || seen.has(g.groupId)) continue;
    seen.add(g.groupId);
    unlinkedGroups.push(g);
  }
  for (const d of discovered) {
    if (linkedIds.has(d.group_id) || seen.has(d.group_id)) continue;
    seen.add(d.group_id);
    unlinkedGroups.push({
      groupId: d.group_id,
      name: d.group_name,
      participants: null,
      fromMessages: true,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          Client groups
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Each client needs one WhatsApp group. Approvals are only accepted from the group the
          video was sent to, so a client can never approve someone else&apos;s work.
        </p>

        {linked.length ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr className="text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Client</th>
                  <th className="px-3 py-2 text-left font-medium">Group</th>
                  <th className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {linked.map((g) => (
                  <tr key={g.group_id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{g.company_name}</td>
                    <td className="px-3 py-2">
                      {g.group_name || (
                        // Not "unnamed" — the group has a name, we just can't
                        // read it on this WhatsApp Web version. Saying it has
                        // none invites someone to go looking for the problem
                        // in WhatsApp, where there isn't one.
                        <span
                          className="text-muted-foreground"
                          title="WhatsApp doesn't expose group names to this version of the automation. The link works regardless — approvals are matched on the group id."
                        >
                          name not available
                        </span>
                      )}
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                        {g.group_id}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={unlinkAction} className="inline">
                        <input type="hidden" name="group_id" value={g.group_id} />
                        <button
                          type="submit"
                          disabled={unlinking}
                          className={buttonClasses({ variant: "ghost", size: "sm" })}
                          title="Stop accepting approvals from this group"
                        >
                          <Unlink className="h-3.5 w-3.5" /> Unlink
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No groups linked yet. Pick one below to get started.
          </p>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">Link a group</p>

          {!serviceReachable ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Can&apos;t list groups — the WhatsApp service is unreachable. Start it and reload.
              </span>
            </p>
          ) : unlinkedGroups.length === 0 ? (
            <div className="space-y-2 rounded-md border border-dashed border-border p-4 text-sm">
              {listWarning ? (
                <>
                  {/*
                    How loudly to say this depends on whether it is currently
                    costing anything.

                    With a group already linked, the message route plainly
                    works and the reader has used it — so the limitation is a
                    footnote and the instructions are the point. With nothing
                    linked, an empty picker is inexplicable without it, and it
                    goes first.
                  */}
                  {linked.length === 0 ? (
                    <p className="flex items-start gap-2 text-warning">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{listWarning}</span>
                    </p>
                  ) : null}

                  {/* The reliable path when WhatsApp won't enumerate: a message
                      that arrives carries its own group id. */}
                  <p className="font-medium">
                    {linked.length
                      ? "To add another group:"
                      : "To add a group:"}
                  </p>
                  <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
                    <li>Create the group in WhatsApp and add this number to it</li>
                    <li>
                      Send any message in that group — even just <b>hi</b>
                    </li>
                    <li>Reload this page; the group will appear in the list here</li>
                  </ol>

                  {linked.length ? (
                    <p className="text-xs text-muted-foreground">
                      Groups appear here once they message us, rather than being
                      listed by WhatsApp — this version of WhatsApp Web won&apos;t
                      enumerate them. Sending and receiving are unaffected.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">
                  Every group this account is in has already been linked. Create the group in
                  WhatsApp first, add this number to it, then reload.
                </p>
              )}
            </div>
          ) : (
            <form action={linkAction} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label htmlFor="client_id" className="text-xs text-muted-foreground">
                  Client
                </label>
                <Select id="client_id" name="client_id" required className="h-9 w-48 text-sm">
                  <option value="">Choose…</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company_name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <label htmlFor="group_id" className="text-xs text-muted-foreground">
                  WhatsApp group
                </label>
                {/* Chosen from the live list, never typed — a mistyped id would
                    save happily and then silently match nothing. */}
                <Select id="group_id" name="group_id" required className="h-9 w-64 text-sm">
                  <option value="">Choose…</option>
                  {unlinkedGroups.map((g) => (
                    <option key={g.groupId} value={g.groupId}>
                      {g.name || g.groupId}
                      {g.participants ? ` (${g.participants})` : ""}
                      {/* Marked because it's the stronger signal: a message
                          from this group has already reached us. */}
                      {g.fromMessages ? " — seen in messages" : ""}
                    </option>
                  ))}
                </Select>
              </div>

              <button
                type="submit"
                disabled={linking}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                {linking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                Link
              </button>
            </form>
          )}

          {linkState.error ? (
            <p className="text-xs text-destructive">{linkState.error}</p>
          ) : null}
          {linkState.ok && linkState.message ? (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> {linkState.message}
            </p>
          ) : null}
          {unlinkState.message ? (
            <p className="text-xs text-muted-foreground">{unlinkState.message}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
