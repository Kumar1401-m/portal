"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, Lock } from "lucide-react";
import type { Role } from "@/lib/auth";
import { navForRole } from "./nav-config";
import { cn } from "@/lib/utils";

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
              <item.icon className="h-[18px] w-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110" />
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
