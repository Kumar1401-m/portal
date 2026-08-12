"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, Lock, Loader2 } from "lucide-react";
import type { Role } from "@/lib/auth";
import { navForRole, type NavItem } from "./nav-config";
import { cn } from "@/lib/utils";

/**
 * The clicked item's own icon becomes a spinner while the page is on its way.
 *
 * `loading.tsx` covers the main panel, but the eye is still on the thing that
 * was just clicked, and a menu item that looks identical a moment after you
 * press it is what made people press it twice. This turns the icon over the
 * instant the navigation starts.
 *
 * Its own component because `useLinkStatus` only reports for the `<Link>` it
 * sits inside — read from the parent it would report nothing, silently.
 */
function NavIcon({ item }: { item: NavItem }) {
  const { pending } = useLinkStatus();
  if (pending) {
    return <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin" aria-hidden />;
  }
  return (
    <item.icon className="h-[18px] w-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110" />
  );
}

export function Sidebar({
  role,
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = navForRole(role);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white">
          <Sparkles className="h-5 w-5" />
        </div>
        <span className="text-base font-semibold text-foreground">NVK Hub</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                "transition-all duration-200 hover:translate-x-0.5",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              {active ? (
                <span className="animate-fade-in absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-current" />
              ) : null}
              <NavIcon item={item} />
              <span className="flex-1">{item.label}</span>
              {!item.ready ? (
                <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Coming soon" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-4 text-xs text-muted-foreground">
        Rebuilt in Next.js · v1
      </div>
    </div>
  );
}
