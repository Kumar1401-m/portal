/**
 * The automation map's one piece of judgement: is a job still alive?
 *
 * A heartbeat that cries wolf is a heartbeat nobody reads, and one that never
 * does is a job that stays stopped for a fortnight. The margin is the whole
 * feature, so it is the thing tested.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const SRC = process.env.PORTAL_SRC;
const m = await import(pathToFileURL(`${SRC}/lib/automation-map.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const NIGHTLY = 60 * 24;
const now = Date.parse("2026-08-18T06:00:00Z");
/** A run `hours` before `now`, written the way the app writes times: UTC. */
const ranHoursAgo = (hours, okFlag = 1) => ({
  job: "x",
  ran_at: new Date(now - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
  ok: okFlag,
  summary: null,
});

/* ---------------- late means missed twice, not missed once ---------------- */
{
  assert.equal(m.health(ranHoursAgo(2), NIGHTLY, now), "ok");

  // The one that matters: a nightly job looked at just after midnight has not
  // run for over 24 hours and has not failed at anything.
  assert.equal(m.health(ranHoursAgo(25), NIGHTLY, now), "ok", "25 hours is not a failure");
  assert.equal(m.health(ranHoursAgo(50), NIGHTLY, now), "ok", "nor is one clean miss");
  assert.equal(m.health(ranHoursAgo(80), NIGHTLY, now), "late", "two consecutive misses is");

  // The fast one moves on its own scale — a 15-minute job silent for an hour
  // is late even though a nightly job silent for an hour is fine.
  assert.equal(m.health(ranHoursAgo(1), 15, now), "late");
  ok("a job is overdue at three intervals, so nothing turns red for being early");
}

/* ---------------- never run, and ran but failed, are different ---------------- */
{
  assert.equal(m.health(undefined, NIGHTLY, now), "never", "no row at all");
  assert.equal(m.health({ job: "x", ran_at: "", ok: 1 }, NIGHTLY, now), "never");
  assert.equal(m.health({ job: "x", ran_at: "not a date", ok: 1 }, NIGHTLY, now), "never");

  // Ran on time and came back unhappy. Reporting that as "Running" is how a
  // job that fails every night looks healthy for a month.
  assert.equal(m.health(ranHoursAgo(2, 0), NIGHTLY, now), "failing");

  // Every state has words behind it, so the map never says it in colour alone.
  for (const state of ["ok", "late", "never", "failing"]) {
    assert.ok(m.HEALTH_TEXT[state], `${state} has a label`);
  }
  ok("never run, ran and failed, and running are three different answers");
}

/* ---------------- the map itself is wired up ---------------- */
{
  const keys = new Set(m.NODES.map((n) => n.key));
  for (const e of m.EDGES) {
    assert.ok(keys.has(e.from), `${e.from} is a real stage`);
    assert.ok(keys.has(e.to), `${e.to} is a real stage`);
    assert.ok(e.label, "and every arrow says what does the moving");
  }
  // Two of the eight steps are a person's — the map's whole point is being
  // honest about which.
  assert.ok(m.EDGES.some((e) => !e.automated), "the manual steps are marked manual");
  assert.ok(m.EDGES.some((e) => e.automated), "and the automatic ones automatic");

  // Every job named on an edge is one the panel below actually shows a
  // heartbeat for, or the arrow claims a watchdog that does not exist.
  const jobs = new Set(m.JOBS.map((j) => j.key));
  for (const e of m.EDGES.filter((x) => x.job)) {
    assert.ok(jobs.has(e.job), `${e.job} is a job with a heartbeat`);
  }
  ok("every arrow joins two real stages, and every job it names is watched");
}

/* ---------------- every job on the page has something that calls it ---------------- */
{
  /*
   * The failure this closes, and it had already happened twice.
   *
   * The Automations page lists a job, gives it an interval and shows a
   * heartbeat — and none of that requires anybody to have wired a scheduler to
   * it. Three of the eight had none: the post-insights sync, the Marketing
   * Brain and the night shift were written, deployed, listed, and never once
   * run. The board reported "Never run" and that read as new rather than as
   * broken, so analytics sat on whatever numbers a person had last refreshed
   * by hand.
   *
   * A job is only real if something out there fetches its URL. The schedulers
   * are Vercel Cron and the n8n workflows, both of which are files in this
   * repo, so this is checkable rather than a matter of belief.
   */
  const root = `${SRC}/../..`;
  const scheduled = new Set();
  for (const p of JSON.parse(fs.readFileSync(`${SRC}/../vercel.json`, "utf8")).crons ?? []) {
    scheduled.add(p.path.split("?")[0]);
  }
  const wf = `${root}/n8n/workflows`;
  for (const file of fs.readdirSync(wf)) {
    for (const n of JSON.parse(fs.readFileSync(`${wf}/${file}`, "utf8")).nodes ?? []) {
      const url = n.parameters?.url;
      if (typeof url === "string" && url.includes("/api/")) {
        scheduled.add("/api/" + url.split("/api/")[1].split("?")[0]);
      }
    }
  }

  /** Which endpoint each job on the page is behind. */
  const ENDPOINT = {
    publishing: "/api/automation/publish/run",
    whatsapp_reminders: "/api/automation/whatsapp/run",
    whatsapp_outbox: "/api/automation/whatsapp/outbox",
    ads_sync: "/api/automation/ads/sync",
    insights_sync: "/api/automation/insights/sync",
    ai_insights: "/api/automation/insights/brain",
    ai_decisions: "/api/automation/decisions",
    monthly_reports: "/api/automation/reports/monthly",
  };

  for (const j of m.JOBS) {
    assert.ok(j.key in ENDPOINT, `${j.key} is on the page but nothing here says what runs it`);
    if (ENDPOINT[j.key] === null) continue;
    assert.ok(
      scheduled.has(ENDPOINT[j.key]),
      `${j.key} is listed with a ${j.everyMinutes}-minute interval but no cron or n8n workflow fetches ${ENDPOINT[j.key]}`
    );
  }
  ok("every job the Automations page promises has a scheduler behind it");
}

/* ---------------- and accepts the secret its scheduler sends ---------------- */
{
  /*
   * Wiring a job to a scheduler is only half of it.
   *
   * Every n8n workflow in this repo sends `CRON_SECRET` — the README says to
   * paste that one into each of them — while most of these endpoints sat
   * behind a guard that took the automation key and nothing else. The ad sync,
   * the YouTube runner and the whole nightly chain answered 401 to their own
   * caller, nightly, from workflows that were imported and switched on. It
   * looked like a mistyped key rather than the wrong door.
   *
   * The rule lives in the two shared guards rather than in each route, so this
   * checks the rule, then that no route has quietly stepped around it.
   */
  const api = fs.readFileSync(`${SRC}/lib/automation-api.ts`, "utf8");
  const body = (name) => (api.split(name)[1] ?? "").split(/^}/m)[0];
  for (const entry of ["export function guard(", "export async function readAuthorized("]) {
    assert.ok(
      body(entry).includes("isAuthorizedCronRequest("),
      `${entry.trim()} must take the cron secret — it is what every scheduler here sends`
    );
  }

  const SCHEDULED_ROUTES = [
    "publish/run", "analyse", "insights/sync", "insights/brain", "decisions",
    "ads/sync", "whatsapp/run", "whatsapp/outbox", "youtube/queue", "reports/monthly",
  ];
  for (const r of SCHEDULED_ROUTES) {
    const src = fs.readFileSync(`${SRC}/app/api/automation/${r}/route.ts`, "utf8");
    assert.ok(
      ["guard(request)", "readAuthorized(", "isAuthorizedCronRequest("].some((g) => src.includes(g)),
      `${r} is fetched on a schedule and must go through a guard that accepts the cron secret`
    );
    assert.ok(
      !src.includes("isAuthorizedAutomationRequest("),
      `${r} reaches past the shared guard to the automation-key-only check`
    );
  }
  ok("every scheduled endpoint accepts the secret a scheduler can actually send");
}


/* ---------------- and the deploy cannot lie about itself ---------------- */
{
  /*
   * The WhatsApp service reports its own commit at `/health`, and that field
   * exists because a feature that was simply never deployed once cost an
   * afternoon of debugging a parser that was fine.
   *
   * It then did exactly the same thing again. The hash lived in `deploy/.env`
   * and only `hostinger.sh` ever rewrote it, so the ordinary
   * `docker compose up -d --build` left the previous value sitting there —
   * and the endpoint whose only job is catching a stale deploy reported a
   * twelve-day-old hash on a container that had just been rebuilt.
   *
   * Interpolated from the shell now, so it describes the tree being built, or
   * says "unknown". Either is honest; the old behaviour could be neither.
   */
  const compose = fs.readFileSync(`${SRC}/../../deploy/docker-compose.yml`, "utf8");
  assert.ok(
    compose.includes("BUILD_SHA: ${BUILD_SHA:-unknown}"),
    "the running commit comes from the shell that built it, not from a file somebody edits"
  );
  ok("the service cannot report a commit it is not running");
}
await finish(pass);
