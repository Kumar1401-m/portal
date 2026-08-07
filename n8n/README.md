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

Easiest route: open the `.json` file, select all, copy — then click on an empty n8n
canvas and press **Ctrl+V**. n8n builds the workflow from the clipboard. The
**Workflows → Import from File** menu does the same thing if you prefer.

Then:

1. Create the credential once (below).
2. Open the HTTP node and select it there.
3. Toggle the workflow **Active**.

The portal URL is written into the nodes as `https://nvkhub.vercel.app` rather than
read from an environment variable, so importing needs no configuration on the n8n
container. If the portal ever moves, it is one field in one node per workflow.

## The credential

**Credentials → New → Header Auth**

| Field | Value |
|---|---|
| Name | `Portal CRON_SECRET` |
| Header name | `Authorization` |
| Header value | `Bearer <the CRON_SECRET>` |

The secret itself is in `deploy/.env` and in the Vercel project's environment variables.
It is not written down here, and it should not be pasted into a chat window or a commit.

The word `Bearer` and one space must be in front of it. Without them the portal returns
401 and the workflow stops with the response body visible in the execution log.

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
