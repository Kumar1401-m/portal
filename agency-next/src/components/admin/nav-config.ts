import type { Role } from "@/lib/auth";
import {
  Briefcase,
  Megaphone,
  Gauge,
  LayoutDashboard,
  CalendarCheck,
  Users,
  ClipboardList,
  CheckCircle2,
  Image as ImageIcon,
  CreditCard,
  Wallet,
  BarChart3,
  TrendingUp,
  Target,
  Workflow,
  Sparkles,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: Role[];
  ready?: boolean; // built vs. "coming soon"
  /** Which drawer it lives in. Absent means it sits on its own at the top. */
  group?: GroupKey;
};

export type GroupKey = "production" | "clients" | "money" | "growth";

/**
 * The four drawers, named for the work rather than for the software.
 *
 * Nineteen items in one flat column meant scrolling to reach Settings and
 * reading the whole list to find anything — the nav had grown one line at a
 * time and nobody had ever looked at it whole.
 *
 * The headings are the four things an agency actually does in a day: make the
 * work, look after the clients, count the money, grow the accounts. Somebody
 * looking for the ads board thinks "growth", not "which of these nineteen
 * words was it".
 *
 * Dashboard, My work and Settings stay outside a drawer on purpose. The first
 * two are where people land, and Settings is the one thing you want to reach
 * without remembering which box it went in.
 */
export const NAV_GROUPS: { key: GroupKey; label: string; icon: LucideIcon }[] = [
  { key: "production", label: "Production", icon: ClipboardList },
  { key: "clients", label: "Clients", icon: Users },
  { key: "money", label: "Money", icon: Wallet },
  { key: "growth", label: "Growth", icon: TrendingUp },
];

const ADMIN: Role[] = ["super_admin", "admin"];
/** Names individuals and their targets — the super admin's alone. */
const SUPER_ADMIN: Role[] = ["super_admin"];
/** crm sees a subset of the admin modules, always scoped to its assigned clients. */
const ADMIN_OR_CRM: Role[] = ["super_admin", "admin", "crm"];
/**
 * Today's Tasks is the whole agency's board filtered to one date.
 *
 * Everyone who runs the day keeps it. It came off the video editor's nav only,
 * because it showed them every client's task when their own list is what they
 * opened it for — only designers were ever scoped to themselves there — and My
 * work is that list.
 *
 * A video editor's whole portal is therefore My work and the task they open
 * from it. Nothing else appears — not clients, not payments, not the posters
 * board. The nav is the honest list of what the role can open, so an editor
 * never clicks something only to be bounced back to where they started.
 */
const DAY_BOARD: Role[] = ["super_admin", "admin", "poster_designer", "crm"];
/**
 * My work is one person's own assigned work, so it is for the people work is
 * assigned to. A super admin's would be empty, and an empty screen in the nav
 * of the person who runs the place is just a wrong turn — they have the
 * Dashboard and Tasks, which show everybody's.
 */
const MAKERS: Role[] = ["admin", "poster_designer", "video_editor"];
/**
 * The Posters board spans every client and carries the approve-and-send step.
 * A designer's own posters, with the box to submit them, live on My work — so
 * they have one screen rather than two that are mostly each other.
 */
const POSTER_BOARD: Role[] = ["super_admin", "admin"];

/** Admins see every module. */
export const NAV: NavItem[] = [
  // Outside the drawers: where people land, and where they go to fix things.
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ADMIN_OR_CRM, ready: true },
  /*
   * Called "Dashboard" for the people who have no other one — see
   * `navSectionsForRole`. An admin has both this and /dashboard, so for them
   * it keeps its own name rather than putting two "Dashboard" links in one nav.
   */
  { label: "My work", href: "/my-work", icon: Briefcase, roles: MAKERS, ready: true },

  /* Making the work, and the people who make it. */
  { label: "Today's Tasks", href: "/today", icon: CalendarCheck, roles: DAY_BOARD, ready: true, group: "production" },
  // Writing the month's content is production work, so it sits with the rest
  // of it rather than being reachable only through a client's own page.
  { label: "Content studio", href: "/studio", icon: Sparkles, roles: ADMIN_OR_CRM, ready: true, group: "production" },
  { label: "Tasks", href: "/deliverables", icon: ClipboardList, roles: ADMIN_OR_CRM, ready: true, group: "production" },
  { label: "Posters", href: "/poster", icon: ImageIcon, roles: POSTER_BOARD, ready: true, group: "production" },
  // Approvals is the gate every task passes through on its way out, so it
  // belongs with the work rather than with the client relationship.
  { label: "Approvals", href: "/approvals", icon: CheckCircle2, roles: ADMIN_OR_CRM, ready: true, group: "production" },
  { label: "Team", href: "/team", icon: Gauge, roles: SUPER_ADMIN, ready: true, group: "production" },

  /* The relationship: who they are and what they are shown. */
  { label: "Clients", href: "/clients", icon: Users, roles: ADMIN_OR_CRM, ready: true, group: "clients" },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: ADMIN_OR_CRM, ready: true, group: "clients" },

  /* Money in and money out are one question, so they share a drawer. */
  { label: "Payments", href: "/payments", icon: CreditCard, roles: ADMIN, ready: true, group: "money" },
  { label: "Expenses", href: "/expenses", icon: Wallet, roles: ADMIN, ready: true, group: "money" },

  /* Growing the accounts: what it cost, what it did, who is next. */
  { label: "Ad Management", href: "/ads", icon: Megaphone, roles: ADMIN_OR_CRM, ready: true, group: "growth" },
  { label: "Analytics", href: "/analytics", icon: TrendingUp, roles: ADMIN_OR_CRM, ready: true, group: "growth" },
  { label: "Leads", href: "/leads", icon: Target, roles: ADMIN_OR_CRM, ready: true, group: "growth" },
  { label: "AI", href: "/ai", icon: Sparkles, roles: ADMIN_OR_CRM, ready: true, group: "growth" },
  { label: "Automations", href: "/automations", icon: Workflow, roles: ADMIN, ready: true, group: "growth" },

  { label: "Settings", href: "/settings", icon: Settings, roles: ADMIN, ready: true },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}

export type NavSection =
  | { kind: "item"; item: NavItem }
  | { kind: "group"; key: GroupKey; label: string; icon: LucideIcon; items: NavItem[] };

/**
 * The sidebar for one role, as the sections it should draw.
 *
 * Two rules keep it honest for the roles that see very little:
 *
 *   - a drawer with nothing in it is not drawn at all;
 *   - a drawer with exactly one item is drawn as that item, not as a drawer.
 *
 * A poster designer sees Today's Tasks and My work. Without the second rule
 * they would get a "Production" heading to click before reaching the single
 * thing under it, which is a worse nav than the flat one it replaced.
 */
export function navSectionsForRole(role: Role): NavSection[] {
  const raw = navForRole(role);

  /*
   * For a designer or an editor, My work *is* their dashboard.
   *
   * It is where they land, it carries their counts, and it holds the box they
   * submit from — calling it something else made it read like a sub-page of a
   * home screen they do not have. An admin has a real /dashboard as well, so
   * for them it keeps its own name: two links both called "Dashboard" would be
   * worse than the name it started with.
   */
  const hasOwnDashboard = raw.some((n) => n.href === "/dashboard");
  const mine = raw.map((n) =>
    n.href === "/my-work" && !hasOwnDashboard ? { ...n, label: "Dashboard" } : n
  );

  const out: NavSection[] = [];

  for (const item of mine.filter((n) => !n.group)) {
    // Settings goes last, after the drawers, wherever it sits in the list.
    if (item.href !== "/settings") out.push({ kind: "item", item });
  }

  for (const g of NAV_GROUPS) {
    const items = mine.filter((n) => n.group === g.key);
    if (items.length === 0) continue;
    if (items.length === 1) out.push({ kind: "item", item: items[0] });
    else out.push({ kind: "group", key: g.key, label: g.label, icon: g.icon, items });
  }

  const settings = mine.find((n) => n.href === "/settings");
  if (settings) out.push({ kind: "item", item: settings });

  return out;
}

/** Which drawer a path belongs to, so the right one opens on arrival. */
export function groupForPath(role: Role, pathname: string): GroupKey | null {
  const match = navForRole(role)
    .filter((n) => n.group)
    .find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  return match?.group ?? null;
}
