/**
 * Who is who, with no dependencies.
 *
 * Split out of `auth.ts` because these are plain facts about roles, while that
 * module reads cookies and redirects — it imports `next/headers`, which is
 * request-scoped and cannot be loaded outside one. A data module that only
 * wants to know which roles can own a task should not have to drag a request
 * context in behind it.
 */

export type Role =
  | "super_admin"
  | "admin"
  | "poster_designer"
  | "video_editor"
  | "crm"
  | "client";

/** Staff = anyone who isn't a client. */
export const STAFF_ROLES: Role[] = [
  "super_admin",
  "admin",
  "poster_designer",
  "video_editor",
  "crm",
];

/**
 * Who a task can be given to — the people who make the work.
 *
 * A crm is out: they own clients, not deliverables. Everyone else who does
 * production is in, and that is the point of this being a constant. Five
 * separate places wrote this list by hand and every one was written before
 * `video_editor` existed, so an editor could not be picked as an assignee
 * anywhere in the portal — on the board, from the client plan, or through the
 * assistant — while the whole editing workflow depended on them being
 * assigned.
 */
export const ASSIGNABLE_ROLES: Role[] = [
  "super_admin",
  "admin",
  "poster_designer",
  "video_editor",
];

/** `'a','b','c'` — for an IN clause. Values are our own constants, never input. */
export const sqlRoleList = (roles: Role[]): string => roles.map((r) => `'${r}'`).join(",");
