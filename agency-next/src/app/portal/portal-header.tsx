"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, LogOut } from "lucide-react";
import type { NotificationRow } from "@/lib/notifications";
import { logout } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/admin/notification-bell";
import { ThemeToggle } from "@/components/admin/theme-toggle";
import { Button } from "@/components/ui/button";

const NAV = [
  { label: "Dashboard", href: "/portal" },
  { label: "Content", href: "/portal/content" },
  { label: "Invoices", href: "/portal/invoices" },
];

export function PortalHeader({
  companyName,
  notifications,
  unread,
}: {
  companyName: string;
  notifications: NotificationRow[];
  unread: number;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2 font-semibold text-primary">
          <Sparkles className="h-5 w-5" />
          <span className="hidden sm:inline">{companyName}</span>
        </div>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active =
              item.href === "/portal"
                ? pathname === "/portal"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />
        <NotificationBell items={notifications} unread={unread} />
        <ThemeToggle />
        <form action={logout}>
          <Button variant="ghost" size="icon" aria-label="Sign out">
            <LogOut className="h-5 w-5" />
          </Button>
        </form>
      </div>
    </header>
  );
}
