import type { Role } from "@/lib/auth";
import {
  Briefcase,
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
const ALL_STAFF: Role[] = ["super_admin", "admin", "poster_designer"];
/** crm sees a subset of the admin modules, always scoped to its assigned clients. */
const ADMIN_OR_CRM: Role[] = ["super_admin", "admin", "crm"];
/**
 * A video editor's whole portal: their own work, and the task they open from it.
 *
 * Nothing else appears — not clients, not payments, not the posters board.
 * The nav is the honest list of what the role can open, so an editor never
 * clicks something only to be bounced back to where they started.
 */
const EDITOR: Role[] = ["video_editor"];
/**
 * Today's Tasks is the whole agency's board filtered to one date.
 *
 * That is the right screen for an admin running the day and for a crm chasing
 * their clients, and the wrong one for the two roles that now have My work: an
 * editor was being shown every client's task when their own list is what they
 * came for, and a super admin already has the Dashboard and Tasks, where the
 * same rows arrive with every filter rather than just the one.
 */
const DAY_BOARD: Role[] = ["admin", "poster_designer", "crm"];

/** Admins see every module bar Today's Tasks — see DAY_BOARD for why. */
export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ADMIN_OR_CRM, ready: true },
  { label: "My work", href: "/my-work", icon: Briefcase, roles: [...ALL_STAFF, ...EDITOR], ready: true },
  { label: "Today's Tasks", href: "/today", icon: CalendarCheck, roles: DAY_BOARD, ready: true },
  { label: "Clients", href: "/clients", icon: Users, roles: ADMIN_OR_CRM, ready: true },
  { label: "Tasks", href: "/deliverables", icon: ClipboardList, roles: ADMIN_OR_CRM, ready: true },
  { label: "Approvals", href: "/approvals", icon: CheckCircle2, roles: ADMIN_OR_CRM, ready: true },
  { label: "Posters", href: "/poster", icon: ImageIcon, roles: ALL_STAFF, ready: true },
  { label: "Payments", href: "/payments", icon: CreditCard, roles: ADMIN, ready: true },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: ADMIN_OR_CRM, ready: true },
  { label: "Settings", href: "/settings", icon: Settings, roles: ADMIN, ready: true },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}
