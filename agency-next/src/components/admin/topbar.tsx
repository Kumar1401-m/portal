"use client";

import { useState } from "react";
import { Menu, LogOut, ChevronDown } from "lucide-react";
import type { SessionUser } from "@/lib/auth";
import type { NotificationRow } from "@/lib/notifications";
import { logout } from "@/lib/actions";
import { label } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "./notification-bell";

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Topbar({
  user,
  onMenu,
  notifications,
  unread,
}: {
  user: SessionUser;
  onMenu: () => void;
  notifications: NotificationRow[];
  unread: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onMenu}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex-1" />

      <NotificationBell items={notifications} unread={unread} />
      <ThemeToggle />

      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-muted"
        >
          <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-xs font-semibold text-white">
            {initials(user.name)}
          </span>
          <span className="hidden text-left sm:block">
            <span className="block text-sm font-medium leading-tight">{user.name}</span>
            <span className="block text-xs leading-tight text-muted-foreground">
              {label(user.role)}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>

        {open ? (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
              <div className="my-1 h-px bg-border" />
              <form action={logout}>
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-muted"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </form>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
