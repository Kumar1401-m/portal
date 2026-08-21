# n8n → the portal

Eight workflows, and the reason each exists.

## What n8n is actually for here

Publishing to Instagram lives **in the portal**, not in n8n. `/api/automation/publish/run`
claims each video, builds the container, polls Instagram until it is encoded, publishes,
stores the permalink and tells the client. n8n does not need to know any of that, and
should not: a workflow that owns half the publishing logic is a workflow you cannot test
and cannot read.

What n8n does is **pull the trigger, often enough**:

| | |
|---|---|
| Vercel Hobby cron | one run per day |
| Posting window | 6–8 PM, the client's clock |
| n8n | every 15 minutes, any timezone |

One run a day cannot serve an evening posting window. That is the whole job.

The VPS matters as much as n8n does — see `../deploy/README.md`. It gives the WhatsApp
service a fixed address, replacing the cloudflared tunnel whose URL changed on every
restart.

## Importing

Open the `.json` file, select all, copy — then click an empty n8n canvas and press
**Ctrl+V**. n8n builds the workflow from the clipboard. **Workflows → Import from
File** does the same thing.

Then **one edit**, and it runs:

1. Double-click the HTTP node.
2. Under **Headers**, replace `PASTE_CRON_SECRET_HERE` with the `CRON_SECRET` value
   from `deploy/.env`. Nothing in front of it — no `Bearer`, no quotes.
3. Save, then **Publish** (older n8n calls it Active).

There is no credential to create. The key travels as a plain header, which is one
field in one obvious place instead of a separate object to build, name and attach —
and the mismatch between those was the only thing that ever went wrong here.

The trade-off, stated plainly: n8n encrypts credentials at rest and does not encrypt
workflow parameters, so the key sits in the workflow on your own VPS. Everything that
key unlocks is a scheduled job on your own portal, and anyone who can read your n8n
workflows can already run those jobs from inside n8n. If that ever stops being true,
move it back to a Header Auth credential — `Authorization` as the name, the same value.

The portal URL is written into the nodes, so nothing needs configuring on the n8n
container. If the portal moves, it is one field per workflow.

## The workflows

**`publish-runner.json`** — every 15 minutes, `GET /api/automation/publish/run`.
Safe at any frequency: each video is claimed with a conditional update before anything
reaches Instagram, so two overlapping runs cannot post the same reel, and a video still
encoding is resumed rather than started again. A non-200 stops the execution and shows
red in n8n's list, because a publisher that quietly stopped working is the failure
worth catching.

**`youtube-runner.json`** — every 15 minutes, and the odd one out: it does the work
itself instead of asking the portal to. Instagram is handed a URL and fetches the file,
so a serverless function can drive it in milliseconds. YouTube takes the bytes —
`videos.insert` is a resumable upload of the whole video, which is the one thing a
Vercel function cannot do. So this workflow downloads the file and uploads it from the
machine n8n already runs on, holding the Google credential n8n already knows how to
store. The portal decides what and when; n8n does the carrying.

It reads the same `scheduled_at` as the Instagram runner, which is what makes a reel and
its Short go out in the same minute — not one waiting on the other. They fail
independently on purpose: Meta rejecting a container should not hold back the Short, and
a channel out of quota should not stop the reel.

Four steps, the same shape as the Instagram one: `queue` → `claim` → upload →
`result`. The claim is a conditional `UPDATE`, so two overlapping runs can never put two
copies on a channel, and a run that dies partway releases its row when the lease
expires.

**Before it will run**, two things: in n8n, add a **YouTube OAuth2 API** credential
signed in as the account that owns the channel, and point the *Upload to YouTube* node
at it; and in the portal, tick **Post the same video to YouTube** on each client that
wants it. It is off by default, per client, for the same reason auto-publish is —
uploading to a live channel nobody mentioned is not a thing to infer.

**`ads-sync.json`** — 03:30 daily, `GET /api/automation/ads/sync`. Pulls each client's
Meta ad spend, impressions and leads into `ad_insights`, one row per client per day, and
that is what the Ad management board reads.

Twenty-eight days every night, not just yesterday. Meta keeps restating conversions as
attribution settles, so a figure fetched once on the day never becomes correct —
re-pulling the window is what makes the board still agree with Ads Manager a month later.
Every row is an upsert on (client, day), so running it twice changes nothing.

One client's expired token comes back inside a 200 with a `failures` list rather than
failing the run: that is a fixable fact for a person, and showing the whole workflow red
every night for it is how a red workflow stops meaning anything. A non-200 does stop and
report, because a spend board that quietly stopped updating still looks like a spend
board.

**Needs `ads_read`.** A Page or Instagram token cannot read ad spend, whatever else it
can do. The client's `meta_ad_account_id` (the `act_…` from Ads Manager) goes on their
edit page.

**`nightly-analyse.json`** — 02:30 daily, `GET /api/automation/analyse`. Watches new
videos so the caption generator has something to work from. Overnight because it costs
an AI call per video and nobody is waiting on it.

**`nightly-chain.json`** — 04:00 daily, and three calls rather than one:
`GET /api/automation/insights/sync` → `.../insights/brain` → `.../decisions`.

The order is the point. The sync reads each published post's reach and engagement back
from Instagram; the Brain works out what changed for each client and why; the night shift
reads the Brain's findings and decides what needs a person in the morning. Run out of
order, the Brain explains yesterday and the night shift acts on it.

These three were written, deployed, listed on the Automations page with a daily
interval — and never wired to anything. For as long as that was true the analytics board
only had whatever numbers somebody had refreshed by hand, and the bell was empty because
nothing filled it. `tests/automations.mjs` now fails if a job is listed on that page with
no cron or workflow fetching its URL, so this cannot quietly happen to the next one.

A failing step stops the chain and turns the run red in n8n, rather than carrying on into
jobs that read what it should have written. The cost is honest: an Instagram hiccup at
04:00 costs that night's Brain too, and both are back the next night.

**`monthly-reports.json`** — 02:00 on the 1st, and the only `POST` here:
`/api/automation/reports/monthly`. Builds each client's month — delivered, reach,
follower growth, ad spend — and puts one message per client into the outbox.

Two things about it are deliberate. A body is required at all, because the endpoint
answers 400 to an empty one. And the body sets `sendAt`, because without it every
report is stamped with the current time and `whatsapp-outbox.json` posts the batch
within five minutes — which is precisely what this endpoint was written not to do. It
queues; it never sends. `sendAt` is 11:00 India time the same morning, so whoever is
on that day has the hours in between to read them in Settings → Reminders and cancel
anything wrong before a client sees a number nobody checked.

Safe to run twice: each client's month is claimed in `scheduled_reports`, so a second
call queues nothing and reports those clients as skipped.

**`whatsapp-reminders.json`** — 10:00 daily, `GET /api/automation/whatsapp/run`. The
routine chases the agency would otherwise have to remember: an unanswered approval after
twelve hours, footage three days before a shoot, the month's plan, an unpaid invoice, and
the team's own digest. Once a day, mid-morning, because a chase at 3am reads as a machine.

**`whatsapp-outbox.json`** — **every 5 minutes**, `GET /api/automation/whatsapp/outbox`.
This one is not a rule; it is the delivery van. When a super admin schedules a reminder
for 6pm in Settings → Reminders, this is what makes 6pm mean 6pm. Nothing due is one
indexed query and no message, so five minutes costs nothing.

Both WhatsApp workflows are safe to overlap and safe to run twice. The daily one claims
each reminder by inserting a row with a unique key before sending; the outbox claims each
message with a conditional `UPDATE`. Either way, exactly one caller can send.

## Turning the Vercel cron off

Once the publisher runs here, the entry in `agency-next/vercel.json` is a second, coarser
copy of the same job. Harmless — the claim logic makes duplicate runs safe — but leaving
it means two places to look when something does not post. Remove the
`/api/automation/publish/run` entry from `vercel.json` and redeploy when you are happy
n8n is running it.

## Checking it works

n8n → the workflow → **Executions**. A healthy run is green with a body like:

```json
{ "ok": true, "posted": 0, "claimed": 0 }
```

`posted: 0` is the normal answer outside the evening window.

If it says `"skipped": "no access token"`, n8n is fine and Instagram is not: the portal
has no `META_ACCESS_TOKEN`, so nothing can be published yet.
