/**
 * The heartbeat this portal has been missing.
 *
 * ## The problem this exists to solve
 *
 * Almost everything automatic in the portal is claim-guarded and safe to call
 * as often as you like — but something has to call it. Vercel's free plan
 * allows two cron jobs and they may only fire once a day, and the portal's own
 * automation map expects publishing every fifteen minutes.
 *
 * The gap between those two facts is the whole bug: a reel scheduled for
 * 7 o'clock in the evening does not go out at 7 o'clock. It goes out whenever
 * the single daily cron next happens to run, which can be nearly a day later.
 * Same for the approval clock that rides along with it, and for the outbox
 * holding messages somebody scheduled for a particular time.
 *
 * Google Apps Script has time-driven triggers that fire every fifteen minutes,
 * on Google's clock, for free. That is exactly the missing piece, and nothing
 * else about the portal has to change: these are the same URLs Vercel Cron
 * calls, with the same bearer token.
 *
 * ## Set it up once
 *
 *   1. script.google.com → New project. Paste this file in, replacing
 *      everything.
 *   2. Project Settings → Script Properties → add two properties:
 *        PORTAL_URL   https://nvkhub.vercel.app        (no trailing slash)
 *        CRON_SECRET  the same value as CRON_SECRET in the portal's Vercel
 *                     environment  (Vercel → Project → Settings → Environment
 *                     Variables). N8N_API_KEY works too — the portal accepts
 *                     either.
 *   3. Run `installTriggers` once from the editor. It will ask for permission
 *      to fetch external URLs; that is `UrlFetchApp` and it is the only thing
 *      this script does.
 *   4. Run `checkNow` once and read the log. It prints the HTTP status of every
 *      endpoint, so a wrong URL or a wrong secret is visible immediately
 *      rather than as silence.
 *
 * The secret lives in Script Properties and never in this file, so the code can
 * be pasted, shared or committed without carrying a credential.
 *
 * ## Why it is safe to run this often
 *
 * Every job behind these URLs claims its work before acting: a publish claims
 * the video, a reminder inserts a unique (kind, scope_key) row before it sends.
 * Two overlapping runs cannot double-post or double-message, and a run with
 * nothing due does nothing. The frequency decides how *soon* something
 * happens, never how many times.
 */

/** Where the portal lives and what proves this is us. Both from Script Properties. */
function config_() {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('PORTAL_URL') || '').replace(/\/+$/, '');
  var secret = props.getProperty('CRON_SECRET') || props.getProperty('N8N_API_KEY') || '';
  if (!url || !secret) {
    throw new Error(
      'Set PORTAL_URL and CRON_SECRET in Project Settings → Script Properties first.'
    );
  }
  return { url: url, secret: secret };
}

/**
 * Call one automation endpoint.
 *
 * `muteHttpExceptions` so a 500 is read rather than thrown: a failing endpoint
 * must be visible in the log as a status, not as a trigger that silently
 * stopped. Apps Script disables a trigger that keeps throwing, which would turn
 * one bad afternoon into a permanently dead heartbeat.
 */
function ping_(path) {
  var cfg = config_();
  try {
    var res = UrlFetchApp.fetch(cfg.url + path, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + cfg.secret },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    var code = res.getResponseCode();
    var body = res.getContentText().slice(0, 300);
    Logger.log(path + ' → ' + code + ' ' + body);
    return code;
  } catch (err) {
    // A network failure is not a reason to stop having a heartbeat.
    Logger.log(path + ' → FAILED ' + err);
    return 0;
  }
}

/**
 * Publishing, and the approval clock that rides with it.
 *
 * This is the one that has to be frequent. It is what makes "scheduled for
 * 7pm" mean 7pm, and what makes "approve within 24 hours or we go ahead" land
 * within a quarter hour of the 24 hours rather than up to a day later.
 */
function runPublisher() {
  ping_('/api/automation/publish/run');
}

/**
 * The WhatsApp reminders, and the outbox inside them.
 *
 * Quarter-hourly as well, because the outbox is in here: "send this at six"
 * means six, and an hourly poll makes it mean "some time in the following
 * hour". Everything else in this job is claimed per day, so the extra runs
 * cost a query and send nothing.
 */
function runReminders() {
  ping_('/api/automation/whatsapp/run');
}

/** The nightly analysis. Vercel's own cron also does this; claiming makes the overlap free. */
function runNightly() {
  ping_('/api/automation/analyse');
}

/**
 * Fetch every endpoint once, now, and log the result.
 *
 * The first thing to run after setting this up, and the first thing to run
 * when somebody says the automation has stopped: it separates "the schedule
 * is not firing" from "the portal is refusing us", which need completely
 * different fixes and look identical from the outside.
 */
function checkNow() {
  var codes = [
    runPublisher(),
    runReminders(),
    runNightly(),
  ];
  Logger.log('---');
  if (codes.indexOf(401) >= 0) {
    Logger.log('401 means the secret does not match CRON_SECRET in the portal environment.');
  } else if (codes.indexOf(404) >= 0) {
    Logger.log('404 means PORTAL_URL is wrong, or points at a preview deployment.');
  } else if (codes.indexOf(200) >= 0) {
    Logger.log('The portal answered. Run installTriggers if you have not already.');
  }
}

/**
 * Install the schedule, replacing any this script installed before.
 *
 * Deletes first, deliberately: running this twice is the obvious thing to do
 * when unsure whether it worked, and without the delete that would leave two
 * of every trigger running for ever.
 */
function installTriggers() {
  var mine = ['runPublisher', 'runReminders', 'runNightly'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('runPublisher').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('runReminders').timeBased().everyMinutes(15).create();
  // 03:00 in whatever timezone the Apps Script project is set to. Harmless if
  // it overlaps Vercel's own nightly cron — the job claims its work.
  ScriptApp.newTrigger('runNightly').timeBased().atHour(3).everyDays(1).create();

  Logger.log('Installed: publisher every 15 min, reminders every 15 min, nightly at 03:00.');
}

/** Take the schedule back off, leaving the portal untouched. */
function removeTriggers() {
  var mine = ['runPublisher', 'runReminders', 'runNightly'];
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log('Removed ' + n + ' trigger(s).');
}
