/**
 * What a piece of work is allowed to be called, and by whom.
 *
 * Pure on purpose: this decides whether a model may overwrite a title, which
 * is the one place the portal can quietly destroy something a person wrote. It
 * belongs somewhere a test can reach without a database.
 */

/**
 * Titles the portal wrote itself, which the AI may replace.
 *
 * Three shapes, all from `task-plan` and `autoTaskTitle`: nothing at all, the
 * numbered placeholder a generated month gets ("Video 12", "Poster 3"), and
 * the category-and-date one a task with no typed name gets ("Instagram Reel ·
 * 11 Aug"). None of them says anything about the video.
 *
 * Anything else was typed by a person, and a person's title is a decision.
 * Overwriting it because a model watched the footage would be the portal
 * arguing with the brief.
 */
export function isGeneratedTitle(title: string): boolean {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/^(video|poster|reel|post)\s*\d+$/i.test(t)) return true;
  // "Instagram Reel · 11 Aug" — a category, then a day.
  if (/·\s*\d{1,2}\s+\w{3,}/.test(t)) return true;
  return false;
}

/**
 * A board-ready title from whatever the analysis decided the video was about.
 *
 * The topic comes back as a sentence often enough that this has to cap it —
 * something that fits a table cell, and never allowed to be blank. Returns
 * null when there is nothing usable, so the caller keeps the old title rather
 * than replacing a placeholder with an emptier one.
 */
export function titleFromTopic(topic: string | null | undefined): string | null {
  const t = String(topic || "")
    .replace(/["'`]/g, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (t.length < 3) return null;
  const capped = t.length > 90 ? `${t.slice(0, 87).trimEnd()}…` : t;
  const titled = capped.charAt(0).toUpperCase() + capped.slice(1);
  // A "topic" that is itself the placeholder has told us nothing, and writing
  // it back would look like the rename worked.
  return isGeneratedTitle(titled) ? null : titled;
}
