"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, Check } from "lucide-react";
import type { NotificationRow } from "@/lib/notifications";
import { markAllRead } from "@/lib/notification-actions";
import { Button } from "@/components/ui/button";
import { SERVICES, isServiceKey, serviceOf } from "@/lib/services";
import { cn, fmtDate } from "@/lib/utils";

export function NotificationBell({
  items,
  unread,
}: {
  items: NotificationRow[];
  unread: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-10 w-10 place-items-center rounded-md transition-colors hover:bg-muted"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 ? (
          <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 ? (
                <form action={markAllRead}>
                  <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Check className="h-3.5 w-3.5" /> Mark all read
                  </Button>
                </form>
              ) : null}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
              ) : (
                items.map((nRow) => {
                  // Task-linked rows carry their service colour; the rest stay neutral.
                  const svc =
                    isServiceKey(nRow.service) || nRow.video_type ? SERVICES[serviceOf(nRow)] : null;
                  const inner = (
                    <div
                      className={cn(
                        "border-b border-l-2 border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/50",
                        svc ? svc.accent : "border-l-transparent",
                        nRow.is_read ? "" : "bg-primary/[0.04]"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!nRow.is_read ? (
                          <span
                            className={cn(
                              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                              svc ? svc.dot : "bg-primary"
                            )}
                          />
                        ) : (
                          <span className="mt-1.5 h-2 w-2 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-snug">{nRow.title}</p>
                          {nRow.body ? (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{nRow.body}</p>
                          ) : null}
                          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            {svc ? (
                              <span className={cn("rounded-full px-1.5 py-0.5 font-medium", svc.chip)}>
                                {svc.short}
                              </span>
                            ) : null}
                            {fmtDate(nRow.created_at)}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                  return nRow.link ? (
                    <Link key={nRow.id} href={nRow.link} onClick={() => setOpen(false)} className="block">
                      {inner}
                    </Link>
                  ) : (
                    <div key={nRow.id}>{inner}</div>
                  );
                })
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
