/**
 * When each scheduled job last ran, and how it went.
 *
 * "Is this actually running?" is the question every scheduled job eventually
 * gets asked, and until now the portal could not answer it. The record of
 * what was *sent* is not the same answer: a job that runs faithfully every
 * morning and finds nothing to do leaves exactly the same trace as a job
 * nobody ever switched on. Only a heartbeat separates the two.
 *
 * One row per job, overwritten each run. History would be a different feature
 * with a different cost; what anyone needs here is "when did this last work".
 */
import "server-only";
import { execute, query, hasColumn } from "./db";

export type JobName =
  | "whatsapp_reminders"
  | "whatsapp_outbox"
  | "ads_sync"
  | "insights_sync"
  | "ai_insights"
  | "ai_decisions"
  | "monthly_reports"
  /* The one everything else exists to lead up to. */
  | "publishing";

export type JobRun = {
  job: string;
  ran_at: string;
  ok: number;
  summary: string | null;
};

export const runsReady = () => hasColumn("automation_runs", "ran_at");

/** UTC, like every other app-written time — never the database's own clock. */
const nowUtc = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * Note that a job ran.
 *
 * Never throws. A heartbeat that could break the job it measures would be
 * worse than no heartbeat: the reminders matter, knowing when they last went
 * out is a convenience.
 */
export async function recordRun(job: JobName, ok: boolean, summary: string): Promise<void> {
  try {
    await execute(
      `INSERT INTO automation_runs (job, ran_at, ok, summary) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE ran_at = VALUES(ran_at), ok = VALUES(ok), summary = VALUES(summary)`,
      [job, nowUtc(), ok ? 1 : 0, summary.slice(0, 500)]
    );
  } catch {
    /* an install without the table simply has no heartbeat to show */
  }
}

export async function lastRuns(): Promise<Record<string, JobRun>> {
  try {
    const rows = await query<JobRun>("SELECT job, ran_at, ok, summary FROM automation_runs");
    return Object.fromEntries(rows.map((r) => [r.job, r]));
  } catch {
    return {};
  }
}
