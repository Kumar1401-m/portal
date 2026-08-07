import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, resolving conflicts (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as Indian Rupees. */
export function money(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(v);
}

/** Title-case a snake_case / kebab-case machine label. */
export function label(s: string | null | undefined): string {
  if (!s) return "";
  if (s === "crm") return "CRM";
  return String(s)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short human date (e.g. "27 Jul 2026"), safe on null. */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Current month key in YYYY-MM (matches deliverables.month_key). */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * What a task is called when nobody typed a name for it.
 *
 * The title is not optional as far as the rest of the portal is concerned —
 * it is what the list shows, what the approval message says and what the
 * client reads in WhatsApp — so a blank one becomes a name built from what
 * the form does know: the category, and the day it is due.
 *
 * Category and date, in that order, because the lists sort by date and the
 * category is what tells two of a client's tasks apart at a glance.
 */
export function autoTaskTitle(category: string, dueDate?: string | null): string {
  // The column is VARCHAR(255) and the category comes off a form, so trim the
  // category rather than the finished title — cutting the whole string would
  // lose the date, which is the half that tells two tasks apart.
  const cat = label(category).trim().slice(0, 200) || "Task";
  const day = dueDate ? new Date(dueDate) : new Date();
  if (Number.isNaN(day.getTime())) return cat;
  const when = day.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  return `${cat} · ${when}`;
}
