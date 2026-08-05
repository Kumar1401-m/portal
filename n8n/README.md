# n8n automation

One workflow: publishing approved content to Instagram.

| File | Trigger | What it does |
| --- | --- | --- |
| `01-instagram-auto-publisher.json` | every 5 min | Publishes scheduled reels/posts to Instagram, notifies the client |

## The division of labour

n8n does the *moving* — polling, calling Meta, waiting on the encoder,
retrying. The portal does the *deciding* — what's due, who gets it, whether a
failure should be retried, what a report says.

That split is deliberate. n8n has no transactions and can run two executions at
once, so anything that must happen exactly once (claiming a post, recording a
send) lives in the database behind a conditional `UPDATE` or a unique key.
It also means re-importing or editing a workflow can never change what a client
is told.

The consequence worth knowing: **the workflow JSON is disposable.** Delete it,
re-import it, edit it freely — the portal's state is unaffected.

## Setup

### 1. Migrate the database

```bash
node database/migrate.js
```

No shell (Vercel + a hosted database)? Sign in to the portal as super admin and
use **Settings → Database → Apply pending columns**, which runs the same list.

### 2. Set the portal's environment

```env
N8N_API_KEY=<a long random string>
META_ACCESS_TOKEN=<long-lived page token>     # optional, for the portal's own Graph calls
WHATSAPP_PHONE_NUMBER_ID=...                  # optional, if the portal should send WhatsApp
WHATSAPP_ACCESS_TOKEN=...
```

Generate the key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set n8n's environment

Copy `.env.example` into your n8n instance. `PORTAL_API_KEY` must equal the
portal's `N8N_API_KEY`.

`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required — n8n blocks `$env` in nodes by
default and every credential in these workflows comes from it.

### 4. Import the workflows

n8n → **Workflows → Import from File**, one at a time. They import inactive.

### 5. Check the wiring before activating

```bash
curl -H "Authorization: Bearer $PORTAL_API_KEY" \
     https://your-portal.vercel.app/api/automation/health
```

Every `false` in `checks` is a feature that will silently do nothing:

```json
{
  "ok": true,
  "checks": {
    "database": true,
    "publishing_schema": true,
    "r2_storage": true,
    "meta_token": true,
    "whatsapp": false,
    "email_smtp": true,
    "ai_provider": true
  },
  "clients_opted_in": 3,
  "queue_depth": 0,
  "warnings": ["WhatsApp is not configured in the portal (n8n may send it instead)."]
}
```

### 6. Opt a client in

Auto-publishing is **off by default for every client** and has to be turned on
deliberately — the failure mode of getting this wrong is a post going out on a
real account without anyone approving it. Per client you need:

- `ig_user_id` — the Instagram **Business** account id (not the @handle)
- `auto_publish = 1`
- `whatsapp_number` and `email` for notifications
- `ig_access_token` only if that account is outside your Business Manager

### 7. Activate

Activate **01**. Start with one low-stakes Reel on a client who has opted in,
and watch it go out before trusting it with the rest.

## How publishing works

Instagram's API is two steps and a wait:

1. **Create a container** — hand Meta the video URL. Returns immediately; Meta
   downloads and encodes in the background.
2. **Poll `status_code`** until `FINISHED`. Publishing an `IN_PROGRESS`
   container fails.
3. **Publish** the container.

The workflow polls every 30s for up to 6 minutes. A 60-second reel usually
finishes in 30–90s.

### The video URL

Instagram fetches the file itself, so the URL must be publicly reachable for the
life of the request. The portal handles this: a public R2 bucket yields a
permanent URL, a private one a 6-hour signed link.

A Google Drive share link **will not work** — it serves an HTML page, not video
bytes. Upload the finished video to R2 through the portal.

### Retries

Two layers, doing different jobs:

- **Within a run** — n8n retries transient network and 5xx failures 2–3× per
  node. `media_publish` gets only 2 tries: it is the one call with a visible
  side effect, and retrying an ambiguous timeout risks a duplicate post.
- **Across runs** — the portal counts attempts on the deliverable. Up to 4, then
  it stops and notifies an admin. A failed post goes back to `scheduled` and the
  next poll picks it up.

Some Meta errors are permanent and skip the budget entirely — an expired token
(190), a missing permission (200), an unsupported media format (9007) will fail
identically however many times you try.

### Recovering a stuck post

A claim is a 20-minute lease. If an execution dies mid-publish, the lease
expires and the queue offers the post again by itself. Nothing to do.

For a post that has genuinely failed and been fixed, use **Retry** in the portal
— it resets the attempt counter, which is what the queue's budget check reads.

## WhatsApp

The workflow sends a plain text message, which is the simplest thing that works
— but Meta only delivers free-form text within **24 hours** of the recipient's
last message to the business. For most clients that window is never open.

For reliable delivery, register a message template in Meta Business Manager:

```
Hi {{1}}, your post "{{2}}" is now live on Instagram. 🎉
See it here: {{3}}
```

Then set `WHATSAPP_TEMPLATE_NAME` and change the **WhatsApp the client** node's
body to:

```json
{
  "messaging_product": "whatsapp",
  "to": "{{ $json.client_whatsapp }}",
  "type": "template",
  "template": {
    "name": "{{ $env.WHATSAPP_TEMPLATE_NAME }}",
    "language": { "code": "en" },
    "components": [{ "type": "body", "parameters": [
      { "type": "text", "text": "{{ $json.contact_person }}" },
      { "type": "text", "text": "{{ $json.title }}" },
      { "type": "text", "text": "{{ $json.permalink }}" }
    ]}]
  }
}
```

The portal's own `sendPostPublishedWhatsApp` already does template-first with a
text fallback, so an alternative is to drop the WhatsApp node entirely and add
`"whatsapp"` to the `channels` array on the **Email the client** node.

## API reference

All endpoints take `Authorization: Bearer <N8N_API_KEY>` and answer JSON with an
`ok` field. Header auth only — these can publish to live accounts, and a key in
a query string ends up in access logs.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/automation/health` | Config check — run this first |
| GET | `/api/automation/publish/queue` | Posts due now |
| POST | `/api/automation/publish/claim` | Reserve one (the concurrency guard) |
| POST | `/api/automation/publish/result` | Report posted / failed |
| POST | `/api/automation/publish/log` | Breadcrumb for an intermediate step |
| POST | `/api/automation/notify` | Email + WhatsApp the client |

`ok: false` from `/publish/claim` is expected traffic, not an error — another
execution holds the item, or it is already live.

## Troubleshooting

**Queue is always empty.** Check `/health` for `publishing_schema` and
`clients_opted_in`. A client needs `auto_publish = 1`, an `ig_user_id`, and a
deliverable at `instagram_status = 'scheduled'` with `scheduled_at` in the past.

**"No fetchable media URL".** R2 isn't configured, or the video was never
uploaded through the portal. Check `r2_storage` in `/health`.

**Container creation fails with code 190.** The token has expired. Page tokens
last 60 days unless exchanged for a long-lived one.

**Container stays IN_PROGRESS past 6 minutes.** Usually a file Instagram won't
accept: reels must be 3s–15min, 9:16-ish, H.264/AAC in MP4 or MOV. The post is
marked failed with that explanation and retried on the next run.

