import type { Role } from "@/lib/auth";
import {
  LayoutDashboard,
  CalendarCheck,
  Users,
  ClipboardList,
  Clapperboard,
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

/** Admins see every module — nothing here is hidden from them. */
export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ADMIN_OR_CRM, ready: true },
  { label: "Today's Tasks", href: "/today", icon: CalendarCheck, roles: [...ALL_STAFF, "crm"], ready: true },
  { label: "Clients", href: "/clients", icon: Users, roles: ADMIN_OR_CRM, ready: true },
  { label: "Tasks", href: "/deliverables", icon: ClipboardList, roles: ADMIN_OR_CRM, ready: true },
  { label: "Editing", href: "/editor", icon: Clapperboard, roles: [...ALL_STAFF, "crm"], ready: true },
  { label: "Approvals", href: "/approvals", icon: CheckCircle2, roles: ADMIN_OR_CRM, ready: true },
  { label: "Posters", href: "/poster", icon: ImageIcon, roles: ALL_STAFF, ready: true },
  { label: "Payments", href: "/payments", icon: CreditCard, roles: ADMIN, ready: true },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: ADMIN_OR_CRM, ready: true },
  { label: "Settings", href: "/settings", icon: Settings, roles: ADMIN, ready: true },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}
