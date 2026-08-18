"use client";

import { useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, Lock, Loader2, ChevronDown } from "lucide-react";
import type { Role } from "@/lib/auth";
import { navSectionsForRole, groupForPath, type NavItem, type GroupKey } from "./nav-config";
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

function NavLink({
  item,
  active,
  onNavigate,
  nested = false,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  /** Inside a drawer: indented, and the active marker moves in with it. */
  nested?: boolean;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md py-2 text-sm font-medium",
        "transition-all duration-200 hover:translate-x-0.5",
        nested ? "pl-9 pr-3" : "px-3",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      )}
    >
      {active ? (
        <span
          className={cn(
            "animate-fade-in absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-current",
            nested ? "left-3" : "left-0"
          )}
        />
      ) : null}
      <NavIcon item={item} />
      <span className="flex-1">{item.label}</span>
      {!item.ready ? (
        <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Coming soon" />
      ) : null}
    </Link>
  );
}

/**
 * The sidebar, in four drawers named for the work.
 *
 * Nineteen items in one column meant scrolling past most of the portal to
 * reach the end of it. Grouped, the whole nav fits without scrolling and the
 * question changes from "which of these nineteen words" to "is this about the
 * work, the client, the money or growth".
 *
 * **The drawer holding the current page opens by itself**, so arriving
 * anywhere — including by a pasted link — shows you where you are rather than
 * a set of closed boxes. Others stay shut until asked, and opening one does
 * not close the rest: somebody moving between Tasks and Analytics all morning
 * should not have to reopen a drawer each time.
 */
export function Sidebar({
  role,
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const sections = navSectionsForRole(role);
  const here = groupForPath(role, pathname);

  // Initialised from where the page is, then owned by the person clicking.
  const [open, setOpen] = useState<Set<GroupKey>>(() => new Set(here ? [here] : []));

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white">
          <Sparkles className="h-5 w-5" />
        </div>
        <span className="text-base font-semibold text-foreground">NVK Hub</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {sections.map((s) => {
          if (s.kind === "item") {
            return (
              <NavLink
                key={s.item.href}
                item={s.item}
                active={isActive(s.item.href)}
                onNavigate={onNavigate}
              />
            );
          }

          const expanded = open.has(s.key);
          // A closed drawer still says the page is somewhere inside it —
          // otherwise the only marker on screen disappears when you shut it.
          const holdsCurrent = s.items.some((i) => isActive(i.href));

          return (
            <div key={s.key}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(s.key)) next.delete(s.key);
                    else next.add(s.key);
                    return next;
                  })
                }
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                  "transition-colors duration-200",
                  holdsCurrent && !expanded
                    ? "text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                )}
              >
                <s.icon className="h-[18px] w-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110" />
                <span className="flex-1 text-left">{s.label}</span>
                {holdsCurrent && !expanded ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                ) : null}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                    expanded && "rotate-180"
                  )}
                  aria-hidden
                />
              </button>

              {expanded ? (
                <div className="mt-0.5 space-y-0.5">
                  {s.items.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item.href)}
                      onNavigate={onNavigate}
                      nested
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-4 text-xs text-muted-foreground">
        Rebuilt in Next.js · v1
      </div>
    </div>
  );
}
