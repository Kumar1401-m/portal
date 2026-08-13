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
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: Role[];
  ready?: boolean; // built vs. "coming soon"
};

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
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ADMIN_OR_CRM, ready: true },
  { label: "My work", href: "/my-work", icon: Briefcase, roles: MAKERS, ready: true },
  { label: "Today's Tasks", href: "/today", icon: CalendarCheck, roles: DAY_BOARD, ready: true },
  { label: "Clients", href: "/clients", icon: Users, roles: ADMIN_OR_CRM, ready: true },
  { label: "Tasks", href: "/deliverables", icon: ClipboardList, roles: ADMIN_OR_CRM, ready: true },
  { label: "Approvals", href: "/approvals", icon: CheckCircle2, roles: ADMIN_OR_CRM, ready: true },
  { label: "Posters", href: "/poster", icon: ImageIcon, roles: POSTER_BOARD, ready: true },
  { label: "Payments", href: "/payments", icon: CreditCard, roles: ADMIN, ready: true },
  { label: "Ad Management", href: "/ads", icon: Megaphone, roles: ADMIN_OR_CRM, ready: true },
  { label: "Team", href: "/team", icon: Gauge, roles: SUPER_ADMIN, ready: true },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: ADMIN_OR_CRM, ready: true },
  { label: "Settings", href: "/settings", icon: Settings, roles: ADMIN, ready: true },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}
