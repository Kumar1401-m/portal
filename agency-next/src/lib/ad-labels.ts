/**
 * Turning Meta's strings into something that fits a table column.
 *
 * Three small functions with no rendering in them, in their own file so they
 * can be run in a test — both of the first two shipped with a bug the first
 * time, and neither was visible from the screen: one silently stopped
 * shortening anything, the other silently kept the wrong half of an address.
 *
 * All of them keep the original on the element's `title`, so nothing is ever
 * actually lost — only the part shown is chosen.
 */

/** Separators a campaign name might use between the client and the rest. */
const NAME_SEPARATORS = ["-", "–", "—", ":", "|"];

/**
 * The part of an ad's name that is not already in the row.
 *
 * Meta names are written by whoever built the campaign and almost always begin
 * with the client — "Freskos - Followers & Engagement - Liverpool 12km". The
 * Client column sits right beside this one, so that prefix is the same word
 * twice while the part that tells the ads apart runs off the end of the cell.
 *
 * Plain string work rather than a regex built from the client's name. That
 * name would have to be escaped, and a company with a bracket or a dot in it
 * whose name was not escaped properly is either a wrong match or a thrown
 * error, on every row of the board. There is nothing here a regex does better.
 */
export function shortName(name: string, client: string): string {
  const c = client.trim();
  if (!c) return name;
  if (!name.toLowerCase().startsWith(c.toLowerCase())) return name;

  const after = name.slice(c.length).trimStart();
  if (!NAME_SEPARATORS.includes(after[0] ?? "")) return name;

  // Only when something is left. A name that is only the client's name is
  // still better than an empty cell.
  return after.slice(1).trim() || name;
}

/**
 * A place, short enough to read in a column.
 *
 * A dropped pin's name is a full postal address — "1 Secant St, Sydney, New
 * South Wales, Australia +12km" — and at any sane column width that clips to
 * "1 Secant St,", which is the least useful part of it. The last two parts and
 * the radius are what somebody reads it for: a 12km circle and a 1km one are
 * different pieces of work.
 */
export function shortPlace(where: string): string {
  const words = where.trim().split(" ");
  const last = words[words.length - 1] ?? "";

  /*
   * The radius is always the final word and always begins with a plus. Checked
   * character by character rather than with a pattern — the version of this
   * written as a regex had its escapes eaten in transit and matched a literal
   * "s" and "d", which is exactly the sort of break nothing on screen shows.
   */
  const isRadius =
    last.startsWith("+") &&
    (last.endsWith("km") || last.endsWith("mi")) &&
    [...last].some((ch) => ch >= "0" && ch <= "9");

  const body = isRadius ? words.slice(0, -1).join(" ") : where;
  const parts = body
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.length > 2 ? parts.slice(-2) : parts;

  return kept.join(", ") + (isRadius ? ` ${last}` : "");
}

/**
 * Meta's delivery status, in the word somebody would actually say.
 *
 * `ADSET_PAUSED` and `CAMPAIGN_PAUSED` are the two that catch people out: the
 * ad itself is active and delivering nothing, because something above it is
 * switched off. Flattening both to "Paused" would send somebody looking at the
 * ad, which is the one place the problem is not.
 */
export function statusLabel(s: string | null): { text: string; live: boolean } | null {
  if (!s) return null;
  const v = s.trim().toUpperCase();
  if (!v) return null;
  if (v === "ACTIVE") return { text: "Active", live: true };
  if (v === "PAUSED") return { text: "Paused", live: false };
  if (v === "ADSET_PAUSED") return { text: "Ad set paused", live: false };
  if (v === "CAMPAIGN_PAUSED") return { text: "Campaign paused", live: false };
  if (v === "ARCHIVED") return { text: "Archived", live: false };
  if (v === "DELETED") return { text: "Deleted", live: false };
  // Anything Meta adds later reads as itself rather than disappearing.
  return { text: v.replace(/_/g, " ").toLowerCase(), live: false };
}
