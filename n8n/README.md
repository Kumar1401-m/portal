# n8n → the portal

Two workflows, and the reason each exists.

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

**`nightly-analyse.json`** — 02:30 daily, `GET /api/automation/analyse`. Watches new
videos so the caption generator has something to work from. Overnight because it costs
an AI call per video and nobody is waiting on it.

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
