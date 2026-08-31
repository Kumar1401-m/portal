/**
 * When to post, learned from this client rather than assumed about their country.
 *
 * `nextBestPostTime` in `posting.ts` answers with a fixed table: roughly
 * evening, roughly local. That is the right answer for a brand-new account,
 * and it is only ever a guess — it knows the country and nothing about the
 * audience. Two dental clinics in the same city have different audiences, and
 * a fixed table says the same thing to both for ever.
 *
 * This asks the better question once it can be answered: **at what hour has
 * this account's own work actually done best?** `slots()` already computes it
 * from `post_insights`, ranked by engagement rate rather than by reach — a
 * post that reached more people because it happened to be boosted is not
 * evidence about the hour it went out.
 *
 * ## The floor is the point
 *
 * A slot needs `MIN_SLOT_POSTS` posts behind it before it is allowed to move
 * anything. One good Tuesday is not a pattern, and the failure mode of
 * ignoring that is specific and bad: the first post lands at 7 PM, does fine
 * because it is the only one, and every post thereafter is pinned to 7 PM by
 * a single measurement — which then keeps confirming itself, because nothing
 * ever goes out at any other hour to disagree with it.
 *
 * So below the floor this returns null and the country table decides, exactly
 * as before. Above it, the account's own hour wins.
 */
import "server-only";
import { getPosts, slots, hourLabel } from "./analytics";
import { bestPostingTimeFor, nextBestPostTime, scheduleDateToUtc } from "./posting";

/**
 * How many posts an hour needs before it may set the schedule.
 *
 * Three, not two. `slots()` offers a slot at two because two is enough to
 * *mention* to somebody reading a board — they can weigh it themselves. This
 * is different: nobody reads it, it silently decides when a client's post goes
 * out, and a decision made unattended has to clear a higher bar than a
 * sentence on a dashboard.
 */
export const MIN_SLOT_POSTS = 3;

/** How far back to look. A year-old hour says nothing about this audience now. */
const WINDOW_DAYS = 180;

export type LearnedTime = {
  /** Local hour, 0–23, this client's own posts have done best at. */
  hour: number;
  /** How many of their posts are behind it. */
  posts: number;
  /** Average engagement rate in that hour, as a percentage. */
  rate: number;
  /** "7 PM" — for saying it out loud. */
  label: string;
};

/**
 * The hour this client's audience actually turns up, or null if unproven.
 *
 * Null is the common answer and the honest one. A client with three published
 * posts has no hour; saying so is what keeps the country default in charge
 * until there is something better than a guess.
 */
export async function learnedBestHour(clientId: number): Promise<LearnedTime | null> {
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const posts = await getPosts(from, to, { clientIds: [clientId] }).catch(() => []);
  if (posts.length < MIN_SLOT_POSTS) return null;

  const byHour = slots(posts, "hour", MIN_SLOT_POSTS);
  const best = byHour[0];
  if (!best) return null;

  /*
   * One hour is not a comparison.
   *
   * If every post this client has ever made went out at 7 PM, then "7 PM is
   * their best hour" is not a finding — it is the only hour there is any
   * evidence about, and it would lock the schedule to the very habit it was
   * supposed to test. A second hour with its own posts behind it is what makes
   * the first one a winner rather than the only entrant.
   */
  if (byHour.length < 2) return null;

  return {
    hour: Number(best.key),
    posts: best.posts,
    rate: best.avgEngagement,
    label: hourLabel(best.key),
  };
}

/**
 * The next time to post for this client — theirs if it is known, the country's
 * if it is not.
 *
 * A drop-in for `nextBestPostTime`, which it falls back to. The country table
 * still supplies the timezone in both cases: what is learned here is *which
 * hour*, in the client's own local time, and translating a local hour into an
 * instant is the one thing the table has always been good at.
 */
export async function nextPostTimeFor(
  clientId: number,
  country: string | null | undefined
): Promise<{ at: string; hour: number; learned: LearnedTime | null }> {
  const learned = await learnedBestHour(clientId).catch(() => null);
  if (!learned) {
    return { at: nextBestPostTime(country), hour: bestPostingTimeFor(country).hour, learned: null };
  }

  const t = bestPostingTimeFor(country);
  const now = new Date();
  const todayUtcMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), learned.hour, 0) -
    t.utcOffsetMinutes * 60000;
  let target = new Date(todayUtcMs);
  // Today's slot has gone — the next one is tomorrow's, the same rule
  // `nextBestPostTime` follows.
  if (target.getTime() <= now.getTime()) target = new Date(target.getTime() + 86_400_000);

  return {
    at: target.toISOString().slice(0, 19).replace("T", " "),
    hour: learned.hour,
    learned,
  };
}

/**
 * When this task's post should go out — on the day it is down for.
 *
 * `nextPostTimeFor` answers "when is this client's next slot", counting from
 * now. That is the right answer for a task with no day of its own and the
 * wrong one for every task on a plan: a reel dated the 26th and approved on
 * the 20th was scheduled for the 20th's evening, because the only thing the
 * scheduler looked at was the clock. The calendar on the row said the 26th,
 * the post went out on the 20th, and nothing on screen reconciled the two.
 *
 * So the due date decides the day and the hour is still the client's — their
 * own learned hour when the account has earned one, the country's evening when
 * it has not.
 *
 * A due date whose slot has already gone falls back to the next one. Putting a
 * post in the past schedules it for never: the queue only returns rows whose
 * time has arrived *and* is still inside its window, so a slot two days ago is
 * missed the moment it is written.
 */
export async function postingSlotFor(
  clientId: number,
  country: string | null | undefined,
  dueDate: string | null | undefined
): Promise<string> {
  const next = await nextPostTimeFor(clientId, country).catch(() => null);
  const fallback = next?.at ?? nextBestPostTime(country);

  const day = String(dueDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fallback;

  const onDay = scheduleDateToUtc(day, country, next?.hour);
  if (!onDay) return fallback;

  // Still ahead of us, or it is not a slot at all.
  return Date.parse(`${onDay.replace(" ", "T")}Z`) > Date.now() ? onDay : fallback;
}
