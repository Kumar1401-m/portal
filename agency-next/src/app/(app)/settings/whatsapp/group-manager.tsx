"use client";

import { useActionState } from "react";
import { Link2, Unlink, Loader2, Check, TriangleAlert, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { buttonClasses } from "@/components/ui/button";
import { linkGroupAction, unlinkGroupAction, type GroupState } from "../../approvals/whatsapp-actions";
import type { WhatsAppGroup } from "@/lib/whatsapp-approvals";
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
  clients,
  serviceReachable,
}: {
  linked: WhatsAppGroup[];
  available: ServiceGroup[];
  clients: ClientMini[];
  serviceReachable: boolean;
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
  const unlinkedGroups = available.filter((g) => !linkedIds.has(g.groupId));

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
                      {g.group_name || <span className="text-muted-foreground">unnamed</span>}
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
            <p className="text-sm text-muted-foreground">
              Every group this account is in has already been linked. Create the group in WhatsApp
              first, add the agency number to it, then reload this page.
            </p>
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
