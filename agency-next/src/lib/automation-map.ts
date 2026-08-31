/**
 * The automation, drawn.
 *
 * A great deal of this portal runs without anybody pressing anything — the
 * month plan generates, footage gets chased, approvals go out and come back,
 * posts publish, ads and insights sync overnight, the monthly report writes
 * itself. Every piece of that is real and none of it was visible: the only
 * way to know whether the machine was running was to notice it had stopped.
 *
 * So this is the map. Boxes are where work sits right now with the live count
 * in each, arrows are what moves it on, and an arrow says whether a robot or
 * a person does the moving. Beside it, every scheduled job with the time it
 * last ran — because "is this actually running?" is the question the map
 * exists to answer, and a heartbeat is the only thing that answers it.
 *
 * Deliberately not a workflow builder. The workflows already exist in n8n and
 * in this codebase; a drag-and-drop editor would be a second place to define
 * them and a second place for them to disagree.
 */
import "server-only";
import { query } from "./db";
import { onTheFloor } from "./client-status";
import { lastRuns, type JobRun } from "./automation-runs";
import { needsRawFootageSql } from "./raw-footage";

export type NodeKey =
  | "planned"
  | "footage"
  | "editing"
  | "with_client"
  | "changes"
  | "ready"
  | "posted"
  | "failed";

export type FlowNode = {
  key: NodeKey;
  label: string;
  hint: string;
  /** Where a click goes to see the actual rows. */
  href: string;
  tone: "muted" | "amber" | "sky" | "violet" | "emerald" | "rose";
};

/** The pipeline, in the order work travels through it. */
export const NODES: FlowNode[] = [
  {
    key: "planned",
    label: "Planned",
    hint: "On the month plan, not started",
    href: "/deliverables",
    tone: "muted",
  },
  {
    key: "footage",
    label: "Waiting for footage",
    hint: "Blocked on the client, not on us",
    href: "/deliverables?status=waiting_for_raw",
    tone: "amber",
  },
  {
    key: "editing",
    label: "In editing",
    hint: "With the editor or designer",
    href: "/deliverables?status=editing",
    tone: "sky",
  },
  {
    key: "with_client",
    label: "With the client",
    hint: "Sent for approval, waiting on a reply",
    href: "/approvals",
    tone: "violet",
  },
  {
    key: "changes",
    label: "Changes asked",
    hint: "Came back with notes — needs redoing",
    href: "/deliverables?status=changes_requested",
    tone: "rose",
  },
  {
    key: "ready",
    label: "Approved & scheduled",
    hint: "Waiting for its posting slot",
    href: "/deliverables?status=scheduled",
    tone: "emerald",
  },
  {
    key: "posted",
    label: "Posted",
    hint: "Live, this month",
    href: "/analytics",
    tone: "emerald",
  },
  {
    key: "failed",
    label: "Publishing failed",
    hint: "Instagram refused it — needs a human",
    href: "/deliverables?status=failed",
    tone: "rose",
  },
];

export type FlowEdge = {
  from: NodeKey;
  to: NodeKey;
  /** What does the moving. */
  label: string;
  /** False when a person has to do it — those are the gaps in the machine. */
  automated: boolean;
  /** The scheduled job behind it, if any, so its heartbeat can be shown. */
  job?: string;
};

export const EDGES: FlowEdge[] = [
  { from: "planned", to: "footage", label: "Month plan generates the tasks", automated: true },
  {
    from: "footage",
    to: "editing",
    label: "Footage chased on WhatsApp until it arrives",
    automated: true,
    job: "whatsapp_reminders",
  },
  { from: "editing", to: "with_client", label: "Editor submits for review", automated: false },
  {
    from: "with_client",
    to: "ready",
    label: "Client approves — or it auto-approves after 24h",
    automated: true,
    job: "whatsapp_reminders",
  },
  { from: "with_client", to: "changes", label: "Client asks for changes", automated: true },
  { from: "changes", to: "editing", label: "Back to the editor", automated: false },
  { from: "ready", to: "posted", label: "Publisher posts it at its slot", automated: true },
  { from: "ready", to: "failed", label: "Instagram refused it", automated: true },
];

/** The scheduled jobs, what each is for, and how often it should run. */
export const JOBS: { key: string; label: string; hint: string; everyMinutes: number }[] = [
  /*
   * First, because it is the one everything else leads up to — and it was
   * missing from this list entirely. The portal could not answer "is posting
   * working?" at all: the publisher left no trace of having run, so a
   * schedule that had never been wired looked exactly like one that ran every
   * quarter hour and had nothing to do.
   */
  {
    key: "publishing",
    label: "Publishing",
    hint:
      "Puts approved reels on Instagram and Facebook when their slot arrives, and keeps the 12h/24h approval clock",
    everyMinutes: 15,
  },
  {
    key: "whatsapp_reminders",
    label: "WhatsApp reminders",
    hint: "Chases footage, approvals and payments",
    everyMinutes: 60 * 24,
  },
  {
    key: "whatsapp_outbox",
    label: "Message outbox",
    hint: "Sends whatever is scheduled to go out",
    everyMinutes: 15,
  },
  {
    key: "ads_sync",
    label: "Ad insights",
    hint: "Pulls spend, impressions and leads from Meta",
    everyMinutes: 60 * 24,
  },
  {
    key: "insights_sync",
    label: "Post insights",
    hint: "Pulls reach and engagement for published posts",
    everyMinutes: 60 * 24,
  },
  {
    key: "ai_insights",
    label: "Marketing Brain",
    hint: "Works out what changed for each client, and why",
    everyMinutes: 60 * 24,
  },
  {
    key: "ai_decisions",
    label: "Night shift",
    hint: "Decides what needs you tomorrow and puts it in the bell",
    everyMinutes: 60 * 24,
  },
  {
    key: "monthly_reports",
    label: "Monthly reports",
    hint: "Queues each client's month on the 1st",
    everyMinutes: 60 * 24 * 31,
  },
];

/**
 * The jobs whose silence actually costs something.
 *
 * Not every job here is worth interrupting a morning for — a late ad sync
 * means a stale number, and the board says so itself. These three are the ones
 * whose stopping means work the agency promised is simply not happening:
 * nothing publishes, nothing is chased, and nothing scheduled goes out.
 */
export const CRITICAL_JOBS = ["publishing", "whatsapp_outbox", "whatsapp_reminders"];

export type Health = "ok" | "late" | "never" | "failing";

/**
 * Is this job alive?
 *
 * Late at three times its interval, not at one. A nightly job checked at
 * 00:05 has technically not run for 24 hours and 5 minutes, and a map that
 * cries wolf every morning is a map nobody looks at. Three intervals means
 * two consecutive misses before anything turns red.
 *
 * `ranAt` and `now` are both UTC strings written by the app — never the
 * database's own clock, which runs on Indian time here and would make every
 * job look five and a half hours fresher than it is.
 */
export function health(run: JobRun | undefined, everyMinutes: number, nowMs: number): Health {
  if (!run?.ran_at) return "never";
  const at = Date.parse(run.ran_at.replace(" ", "T") + "Z");
  if (Number.isNaN(at)) return "never";
  if (nowMs - at > everyMinutes * 3 * 60_000) return "late";
  return run.ok ? "ok" : "failing";
}

export const HEALTH_TEXT: Record<Health, string> = {
  ok: "Running",
  late: "Overdue",
  never: "Never run",
  failing: "Last run failed",
};

/**
 * How many pieces of work are sitting in each box right now.
 *
 * One query, not eight. These are read together on a page whose whole point
 * is the shape of the pipeline, and eight round trips to draw one diagram is
 * eight chances for the boxes to disagree with each other.
 */
export async function liveCounts(): Promise<Record<NodeKey, number>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT
       SUM(d.status = 'pending') AS planned,
       SUM(${needsRawFootageSql("d")}
           AND (d.status = 'waiting_for_raw'
                OR (d.status = 'pending'
                    AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')))) AS footage,
       SUM(d.status IN ('raw_uploaded','editing','caption_ready')) AS editing,
       SUM(d.status IN ('review','content_review')) AS with_client,
       SUM(d.status = 'changes_requested') AS changes,
       SUM(d.status IN ('approved','scheduled')) AS ready,
       SUM(d.status IN ('posted','completed')
           AND d.month_key = DATE_FORMAT(CURDATE(),'%Y-%m')) AS posted,
       SUM(d.instagram_status = 'failed') AS failed
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE ${onTheFloor()}`
  );
  const r = rows[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0);
  return {
    planned: n(r.planned),
    footage: n(r.footage),
    editing: n(r.editing),
    with_client: n(r.with_client),
    changes: n(r.changes),
    ready: n(r.ready),
    posted: n(r.posted),
    failed: n(r.failed),
  };
}

export type JobStatus = {
  key: string;
  label: string;
  hint: string;
  everyMinutes: number;
  run: JobRun | undefined;
  health: Health;
};

/**
 * The clock is read here rather than passed in from the page.
 *
 * `health` keeps taking one so it stays testable, but a React component may
 * not call `Date.now()` during render — it is impure, and the lint rule that
 * says so is right: a re-render would quietly change what "overdue" means.
 */
export async function jobStatuses(): Promise<JobStatus[]> {
  const runs = await lastRuns().catch(() => ({}) as Record<string, JobRun>);
  const now = Date.now();
  return JOBS.map((j) => {
    const run = runs[j.key];
    return { ...j, run, health: health(run, j.everyMinutes, now) };
  });
}

/* ------------------------------------------------------------------ *
 * What the AI actually does
 * ------------------------------------------------------------------ */

/**
 * Every place a model is called, in the order work meets them.
 *
 * Written because somebody who runs this agency said, plainly, that they could
 * not tell what the AI was doing. That is a fair thing not to know: the calls
 * are scattered across a dozen modules, some fire on a schedule, some when a
 * button is pressed, and none of them announce themselves. "AI" had become a
 * word that meant something unspecified was happening somewhere.
 *
 * So it is written down once, next to the machine it belongs to. Only real
 * call sites are listed — a list that flatters the portal with things it does
 * not do would be worse than no list, because the first time somebody looked
 * for one of them they would stop believing the rest.
 */
export type AiStep = {
  label: string;
  /** What it does, in the words somebody would use out loud. */
  does: string;
  /** What sets it off. */
  when: string;
  /** Where the result shows up. */
  href: string;
};

export const AI_STEPS: AiStep[] = [
  {
    label: "Watches the video",
    does:
      "Frames from across the whole runtime and the sound track go to the model, and it says " +
      "what is in the video — what happens, whether a person is on screen, what is said.",
    when: "When a video is uploaded, and again overnight for anything that was missed.",
    href: "/deliverables",
  },
  {
    label: "Writes the caption",
    does:
      "From what it saw, plus the client's own brief — their audience, tone, banned words, the " +
      "city they trade in — it writes the caption and the hashtags. It never invents an owner, " +
      "a business name or a contact detail that is not in the brief.",
    when: "Straight after it has watched the video, and whenever Regenerate is pressed.",
    href: "/deliverables",
  },
  {
    label: "Suggests what to post",
    does: "Content ideas and poster briefs for a client, built from what that client is for.",
    when: "In the Studio, when somebody asks for ideas.",
    href: "/studio",
  },
  {
    label: "Answers the client in WhatsApp",
    does:
      "Ordinary messages in a client's group get a reply — but only in groups ticked for it, " +
      "and never for an approval command, which is handled by the rules and not by a model.",
    when: "When a client writes in a group where Assistant replies is ticked.",
    href: "/settings/whatsapp",
  },
  {
    label: "Answers you",
    does:
      "The portal assistant. It is given a snapshot already filtered to what you are allowed " +
      "to see, and never the database — so it cannot be talked into another client's numbers.",
    when: "When you ask it something.",
    href: "/assistant",
  },
  {
    label: "Works out what changed",
    does:
      "The Marketing Brain reads each client's numbers and says what moved and what it thinks " +
      "caused it, and the night shift turns that into what needs you tomorrow.",
    when: "Overnight.",
    href: "/ai",
  },
];

/**
 * What to actually do about a job that is not running.
 *
 * "Overdue" and "Never run" name the symptom and stop there, which is how a
 * red badge sits on a page for a month. In every case seen so far the cause
 * has been the same and it is not in this codebase: nothing is calling the
 * endpoint often enough. Vercel's free plan fires two cron jobs, once a day
 * each, and the schedule this map expects is quarter-hourly — so a job can be
 * perfectly written, perfectly deployed, and still only run at breakfast.
 */
export function whyLate(key: string, state: Health): string | null {
  if (state === "ok") return null;

  const clock =
    "Nothing is calling this often enough. Vercel's free plan only fires two cron jobs and " +
    "only once a day — set up the Apps Script clock in automation/apps-script/ to call it " +
    "every 15 minutes, or run it by hand with the button above.";

  if (state === "never") {
    return (
      "This has never run at all. Either the schedule was never wired up, or every attempt " +
      "failed before it could record itself. " + clock
    );
  }
  if (state === "failing") {
    return "It ran and could not finish. The reason is in the line above — fix that, then run it by hand.";
  }
  return key === "publishing" || key === "whatsapp_outbox"
    ? "This is the one that has to be frequent — it is what makes a scheduled time mean anything. " + clock
    : clock;
}
