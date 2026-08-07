# Brief: WhatsApp service + n8n on the Hostinger VPS

A self-contained description of the job, for handing to an assistant that has
no history of this project. Also serves as the setup record.

Copy everything below the line.

---

I run a digital marketing agency portal and need help finishing a server setup.
Ask me to run commands and tell me what to look for in the output — I have
root SSH but I am not a sysadmin.

## What already exists

**The portal** — Next.js 16 (App Router, server actions), MySQL via mysql2 (no
ORM), deployed on Vercel at `https://nvkhub.vercel.app`. The database is hosted
on Railway. It manages clients, monthly content plans, video tasks, approvals
and invoices.

**Instagram publishing is already built into the portal.** A single endpoint,
`GET /api/automation/publish/run`, does the whole job: claims each due video
with a conditional UPDATE, creates the Instagram media container, polls until
Instagram has finished encoding, publishes, stores the permalink, and notifies
the client. It is safe to call as often as you like — overlapping runs cannot
post the same video twice. It authenticates with
`Authorization: Bearer <CRON_SECRET>`.

There is a second endpoint, `GET /api/automation/analyse`, same auth, which
runs overnight AI analysis on new videos.

**A WhatsApp service** — a Node app in `whatsapp-service/` using
whatsapp-web.js 1.34.7, which drives a real headless Chromium. It sends videos
to client WhatsApp groups for approval and receives their replies ("ok",
"approve", "change", or a voice note) back into the portal. It needs a stable
public HTTPS URL because the portal calls it and it calls back.

**Deployment assets already written** — in the repo:
- `deploy/setup.sh` — one-command bootstrap for a fresh Ubuntu VM: installs
  Docker, starts the WhatsApp service, puts Caddy in front for TLS. Takes a
  hostname argument: `bash deploy/setup.sh wa.example.com`. Idempotent.
- `deploy/docker-compose.yml` — one container.
- `deploy/.env` — already filled in with the live keys the portal expects
  (`PORTAL_URL`, `WA_PORTAL_KEY`, `SERVICE_API_KEY`, `WHATSAPP_SERVICE_TOKEN`,
  `CRON_SECRET`). Gitignored. It must be copied to the server, never committed
  or pasted into a chat.
- `n8n/workflows/publish-runner.json` and `n8n/workflows/nightly-analyse.json`
  — importable n8n workflows that call the two endpoints above.

## The server

Hostinger VPS, plan **KVM 1: 1 vCPU, 4 GB RAM, 50 GB disk**.

- OS: **Ubuntu 24.04, with Hostinger's n8n template preinstalled**
- Hostname: `srv1886744.hstgr.cloud` (DNS resolves to the IP)
- IPv4: `200.141.2.209`
- SSH user: `root`
- Location: India — Mumbai

Established by probing from outside:
- Ports **80 and 443 are already in use** — something is reverse-proxying,
  presumably for n8n.
- Port **5678 is closed** from outside, so n8n is behind that proxy rather than
  exposed directly.
- Which proxy it is (Traefik, Caddy, nginx) is **not yet known**, and that is
  the first thing to establish, because `deploy/setup.sh` installs Caddy and
  would collide with whatever is already bound to 80/443.

## What I want done

**1. Point n8n at the portal's publisher.**

Vercel's Hobby plan allows one cron run per day. Posts are scheduled into a
6–8 PM window in the client's timezone, which one daily run cannot serve. n8n
should call `/api/automation/publish/run` every 15 minutes instead.

Import the two workflow files, create a **Header Auth** credential named
`Portal CRON_SECRET` with header `Authorization` and value `Bearer <secret>`,
set `PORTAL_URL` to `https://nvkhub.vercel.app`, and activate both.

A healthy execution returns `{ "ok": true, "posted": 0, "claimed": 0 }`.
`posted: 0` is normal outside the posting window. If it returns
`{ "skipped": "no access token" }` then n8n is working and the portal simply
has no Instagram token yet — that is a separate, known task.

**2. Give the WhatsApp service a permanent home on the same VPS.**

It currently runs behind a cloudflared quick tunnel whose URL changes on every
restart, which breaks the portal's link to it each time. It needs a fixed
HTTPS address.

The open question is how, given 80/443 are taken. Either:
- a subdomain (e.g. `wa.mydomain.com`) routed by the **existing** proxy to the
  WhatsApp container — no second Caddy; or
- a path on the existing hostname, e.g. `srv1886744.hstgr.cloud/wa/`, if the
  proxy supports path routing.

Decide based on what is actually running, then adapt `deploy/setup.sh`
accordingly rather than running it as-is.

Afterwards, set `WHATSAPP_SERVICE_URL` in the Vercel project to the new
address and redeploy, then scan the WhatsApp QR code once from the portal's
Settings → WhatsApp page.

## Constraints

- **Never print, echo or ask me to paste secrets** — no root password, no API
  tokens, no `CRON_SECRET`. They live in `deploy/.env` and in Vercel's
  environment variables. Two access tokens were already leaked earlier in this
  project by pasting them into a chat window; do not repeat that.
- `whatsapp-service/.wwebjs_auth/` holds the logged-in WhatsApp session. It is
  gitignored and must never be committed.
- **Do not send test messages to real client WhatsApp groups.** Use a group I
  create for testing, or a stub.
- Restarting the WhatsApp service repeatedly can leave orphaned Chromium
  processes sharing one session and log the account out. Stop cleanly and
  check for stray processes before starting again.
- 1 vCPU is shared between n8n and a headless Chromium. Expect it to work —
  the service is idle most of the time — but treat CPU contention as a likely
  explanation before assuming a bug.

## How to work with me

Give me one command at a time, say what it does and what I should see back,
and wait for my output before the next one. If something fails, diagnose from
the actual output rather than guessing. Start with step 1, which needs no
server access at all.
