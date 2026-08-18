/**
 * The shape of one requested change.
 *
 * Its own module because the checklist is a client component and
 * `revision-tasks.ts` is `server-only` — importing it for a type pulls the
 * database driver into the browser bundle and fails the build. Third time
 * this split has been needed, after `lead-stages.ts` and `content-kinds.ts`.
 */

export type RevisionItem = {
  id?: number;
  /** Short and imperative — "Change the intro". */
  title: string;
  /** What exactly they asked for, in their own words where possible. */
  detail: string;
  /** Which kind of person does it. Null when it was not obvious. */
  role: string | null;
  done?: boolean;
};
