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

/**
 * Colour for the content track, matching how contentStatusLabel folds it.
 *
 * Signed off is green, waiting on someone is amber, a change asked for is a
 * warning rather than a failure, and not-started is quiet — the point is that
 * a client can read a column of these without reading the words.
 */
export function contentStatusTone(status: string): BadgeTone {
  if (["approved", "scheduled", "posted", "completed"].includes(status)) return "success";
  if (["content_review", "review"].includes(status)) return "warning";
  if (status === "changes_requested") return "danger";
  if (["waiting_for_raw", "raw_uploaded", "editing", "caption_ready", "resolved"].includes(status))
    return "info";
  return "muted";
}

/**
 * Where a piece stands with Instagram, said the way the old board said it.
 *
 * Separate from the workflow status on purpose: a video can be finished,
 * approved and signed off and still not be on Instagram, and "Approved" in
 * the content column has been read as "it went out" more than once.
 *
 * Reads the workflow status as well as posting_status, because the two drift:
 * posting_status is only written by the publisher, so a video marked posted by
 * hand has the workflow status and nothing else.
 */
export function postStatusLabel(status: string, posting?: string | null): string {
  if (posting === "posted" || ["posted", "completed"].includes(status)) return "Posted";
  if (posting === "rejected") return "Failed";
  if (posting === "scheduled" || status === "scheduled") return "Scheduled";
  return "Yet to post";
}

export function postStatusTone(status: string, posting?: string | null): BadgeTone {
  const label = postStatusLabel(status, posting);
  if (label === "Posted") return "success";
  if (label === "Scheduled") return "info";
  if (label === "Failed") return "danger";
  return "muted";
}

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
