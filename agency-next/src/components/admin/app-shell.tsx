"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import type { SessionUser } from "@/lib/auth";
import type { NotificationRow } from "@/lib/notifications";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { cn } from "@/lib/utils";

export function AppShell({
  user,
  notifications,
  unread,
  children,
}: {
  user: SessionUser;
  notifications: NotificationRow[];
  unread: number;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-sidebar-border lg:block">
        <Sidebar role={user.role} />
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none"
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0"
          )}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-64 border-r border-sidebar-border shadow-xl transition-transform",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <button
            className="absolute right-3 top-4 z-10 text-muted-foreground"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
          <Sidebar role={user.role} onNavigate={() => setMobileOpen(false)} />
        </div>
      </div>

      {/* Content */}
      <div className="lg:pl-64">
        <Topbar
          user={user}
          onMenu={() => setMobileOpen(true)}
          notifications={notifications}
          unread={unread}
        />
        {/* Keyed on the route so each navigation replays the entrance animation. */}
        <main key={pathname} className="animate-fade-up mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
