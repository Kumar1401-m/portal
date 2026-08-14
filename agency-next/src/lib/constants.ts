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

/** Mirrors the Badge component's tones — see there for what each one means. */
export type BadgeTone =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "waiting"
  | "active"
  | "muted";

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
 * The same track, said the way it reads to whoever has to act on it.
 *
 * `contentStatusLabel` is written for the client's own board, where "Yet to
 * start" is a fair answer to "where is my post". On Today's Tasks it is not:
 * it names a state without naming whose move it is, so a month of briefs
 * nobody has written looks identical to a month of briefs sitting with a
 * client. These two are the ones that need a person, so these two say who.
 */
export function contentStageLabel(status: string): string {
  if (status === "pending") return "Content to write";
  if (status === "content_review") return "Content with client";
  return contentStatusLabel(status);
}

/**
 * And its colour. A brief nobody has written is the agency's own move, so it
 * is not the quiet grey the rest of "not started yet" gets — that grey is
 * exactly why it was missed.
 */
export function contentStageTone(status: string): BadgeTone {
  if (status === "pending") return "active";
  return contentStatusTone(status);
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
/**
 * Is this piece done — waiting on nobody, needing nothing?
 *
 * Deliberately next to `postStatusLabel`, and deliberately sharing its first
 * line: a board that prints "Posted" on a row is a board showing finished
 * work, and the two must agree about what "posted" means or one of them is
 * lying. They can disagree easily, because a piece can be posted in two
 * different places — the publisher writes `posting_status`, while marking it
 * by hand writes the workflow status, and a row set one way was invisible to
 * a check written the other.
 *
 * Cancelled and rejected are finished too. Nothing is owed on them either.
 */
export function isFinished(status: string, posting?: string | null): boolean {
  if (posting === "posted") return true;
  return ["posted", "completed", "cancelled", "rejected"].includes(status);
}

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

/**
 * Colour for the design track, one meaning per colour.
 *
 * Every one of these used to be "info" — approved, scheduled, in review,
 * resolved and *changes requested* all came out the same orange. Those are the
 * two outcomes it matters most to tell apart, and the column is scanned rather
 * than read, so they were effectively unlabelled.
 *
 *   green  — signed off
 *   red    — needs doing again, or is not going out
 *   blue   — someone is working on it now
 *   violet — sitting with a person for a decision
 *   grey   — not started, or over
 */
export function editorStatusTone(status: string): BadgeTone {
  if (["approved", "scheduled", "posted", "completed"].includes(status)) return "success";
  if (["changes_requested", "rejected"].includes(status)) return "danger";
  if (["raw_uploaded", "editing", "resolved"].includes(status)) return "active";
  if (["waiting_for_raw", "caption_ready", "review"].includes(status)) return "waiting";
  return "muted";
}

/**
 * How far the making has got, and whether it was signed off.
 *
 * Three things were wrong, and all three showed on the board at once.
 *
 * `changes_requested` said **"Edited"**. Somebody had asked for the work to be
 * done again and the column reported it as done — the single most misleading
 * cell on the board.
 *
 * `rejected` and `cancelled` said **"—"**, so the two outcomes worth noticing
 * were the two that looked like missing data.
 *
 * And `posted` said **"Posted"**, repeating the Post status column next to it.
 * Three columns are only worth the width if they answer three questions; this
 * one ends at approval, because that is where the design work ends. Whether it
 * then went out is the next column's business.
 */
/**
 * An invoice, answering the question it is actually opened for.
 *
 * The column showed the workflow status — "Sent" — which says we posted it and
 * nothing about whether the money arrived. Every one of draft, sent, partial
 * and overdue means unpaid, and only one of them said so.
 *
 * The workflow value is kept underneath: `sent` and `overdue` are different
 * things to do about the same fact, so the label carries both — what is owed,
 * and how late.
 */
export function invoiceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    paid: "Paid",
    partial: "Part paid",
    overdue: "Unpaid · overdue",
    sent: "Unpaid",
    draft: "Draft",
    cancelled: "Cancelled",
  };
  return map[status] ?? "Unpaid";
}

/**
 * Green is paid and nothing else is.
 *
 * Draft is grey because nothing is owed yet — it has not been sent. Everything
 * between is money outstanding, and overdue is the one that needs chasing
 * today rather than this month.
 */
export function invoiceStatusTone(status: string): BadgeTone {
  if (status === "paid") return "success";
  if (status === "overdue") return "danger";
  if (status === "partial") return "warning";
  if (status === "sent") return "waiting";
  return "muted";
}

export function editorStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "Yet to start",
    content_review: "Yet to start",
    waiting_for_raw: "Awaiting raw",
    raw_uploaded: "Raw uploaded",
    editing: "Editing",
    caption_ready: "With super admin",
    review: "With client",
    changes_requested: "Changes requested",
    resolved: "Changes done",
    // Approved is the end of this column. Scheduled and posted are still
    // approved work — the Post status column says where they got to.
    approved: "Approved",
    scheduled: "Approved",
    posted: "Approved",
    completed: "Approved",
    rejected: "Rejected",
    cancelled: "Cancelled",
  };
  return map[status] ?? "Yet to start";
}
