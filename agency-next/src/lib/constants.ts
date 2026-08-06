/** Shared enums mirrored from the backend (deliverables workflow). */

export const PLATFORMS = [
  "instagram_reel",
  "instagram_post",
  "instagram_story",
  "facebook_post",
  "ad_creative",
  "other",
] as const;

export const VIDEO_TYPES = ["Reel", "Post", "Story", "Poster", "Ad", "Other"] as const;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const STATUS_LIST = [
  "pending",
  "content_review",
  "waiting_for_raw",
  "raw_uploaded",
  "editing",
  "caption_ready",
  "review",
  "changes_requested",
  "resolved",
  "approved",
  "scheduled",
  "posted",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type Status = (typeof STATUS_LIST)[number];

/** Statuses counted as "done" (client-approved and everything after). */
export const DONE_STATUSES: Status[] = ["approved", "scheduled", "posted", "completed"];

/**
 * The only statuses a video editor may set.
 *
 * Everything here is the edit itself — footage received, cutting, caption
 * done, changes addressed. Deliberately excludes the rest of the board:
 * "approved" means the client signed off, "posted" means it went live. An
 * editor setting either would record something that never happened, and the
 * monthly report counts both.
 */
export const EDITOR_STATUSES: Status[] = [
  "raw_uploaded",
  "editing",
  "caption_ready",
  "resolved",
];

/** A tidy subset for the list-page status filter. */
export const FILTER_STATUSES: Status[] = [
  "pending",
  "content_review",
  "caption_ready",
  "review",
  "changes_requested",
  "approved",
  "posted",
  "completed",
];

/**
 * The single workflow status folds two tracks together. These derive the
 * separate "Content Status" and "Editor Status" labels the old app showed.
 */
export function contentStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "Yet to start",
    content_review: "In content review",
    waiting_for_raw: "Content approved",
    raw_uploaded: "Content approved",
    editing: "Content approved",
    caption_ready: "Content approved",
    review: "In final review",
    changes_requested: "Changes requested",
    resolved: "Resolved",
    approved: "Approved",
    scheduled: "Approved",
    posted: "Approved",
    completed: "Approved",
    rejected: "Rejected",
    cancelled: "Cancelled",
  };
  return map[status] ?? "Yet to start";
}

export type BadgeTone = "default" | "success" | "warning" | "danger" | "info" | "muted";

export function editorStatusTone(status: string): BadgeTone {
  if (["posted", "completed"].includes(status)) return "success";
  if (["editing", "raw_uploaded"].includes(status)) return "warning";
  if (["approved", "scheduled", "caption_ready", "review", "resolved", "changes_requested"].includes(status))
    return "info";
  if (["rejected", "cancelled"].includes(status)) return "muted";
  return "muted";
}

export function editorStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "Yet to start",
    content_review: "Yet to start",
    waiting_for_raw: "Awaiting raw",
    raw_uploaded: "Raw uploaded",
    editing: "Editing",
    caption_ready: "Edited",
    review: "Edited",
    changes_requested: "Edited",
    resolved: "Edited",
    approved: "Ready",
    scheduled: "Scheduled",
    posted: "Posted",
    completed: "Posted",
    rejected: "—",
    cancelled: "—",
  };
  return map[status] ?? "Yet to start";
}
