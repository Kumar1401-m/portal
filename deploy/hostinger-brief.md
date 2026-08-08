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
  (`PORTAL_URL`, `PORTAL_API_KEY`, `SERVICE_API_KEY`, `WHATSAPP_SERVICE_TOKEN`,
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
- Ports **80 and 443 are already in use** — something is reverse-proxying for
  n8n, which is served at `https://n8n.srv1886744.hstgr.cloud`.
- Port **5678 is closed** from outside, so n8n is behind that proxy rather than
  exposed directly.
- Which proxy it is (Traefik, Caddy, nginx) is **not yet known**. Establish it
  first: `deploy/setup.sh` installs Caddy and would take those ports away from
  n8n. `deploy/hostinger.sh` (below) detects it instead.
- **DNS is a wildcard.** `wa.srv1886744.hstgr.cloud`, and any other subdomain,
  already resolves to the IP. No DNS record needs creating and no domain needs
  buying. This settles what the WhatsApp service should be addressed as.

The repo is public at `https://github.com/Kumar1401-m/portal.git`, so the
server can clone it directly. `deploy/.env` is gitignored and must be copied
across separately.

## Already done — do not redo

**n8n calls the publisher every 15 minutes, and it works.** The workflow is
imported, the key is set, and a manual execution returns
`{"ok":true,"considered":0,"posted":0}`. `considered: 0` is correct: the queue
is empty because no video has been approved and scheduled yet.

The key travels as a **plain header parameter written into the workflow**
(`Authorization: <CRON_SECRET>`, no `Bearer` prefix — the portal accepts
either). An n8n Header Auth credential was tried first and abandoned: creating
it, naming its header field, pasting the value and attaching it to the node is
four places to be wrong, and every one of them fails with the same flat 401.

If a key is ever rejected again, `GET /api/automation/whoami` on the portal
says why — header absent, truncated, whitespace, or a different value — and
never echoes the secret back.

## What I want done

**1. Import the second n8n workflow.**

`n8n/workflows/nightly-analyse.json`, same method as the first: paste the JSON
onto a blank canvas, replace `PASTE_CRON_SECRET_HERE` in the HTTP node's
Headers with the `CRON_SECRET` from `deploy/.env`, publish.

**2. Give the WhatsApp service a permanent home on the same VPS.**

It currently runs behind a cloudflared quick tunnel whose URL changes on every
restart, which breaks the portal's link to it each time. It needs a fixed
HTTPS address, and `wa.srv1886744.hstgr.cloud` already resolves to the box.

`deploy/hostinger.sh` is written for exactly this. It detects which proxy owns
80/443 — by published port rather than image name — and adapts:

```
bash deploy/hostinger.sh            # inspects and prints a plan, changes nothing
bash deploy/hostinger.sh --apply    # carries it out
```

It handles Traefik (network + labels), Caddy (one extra site block), and
installs Caddy only if nothing else wants those ports. It refuses to guess at
an unrecognised proxy. It never touches the n8n container.

It has **not been run against a real server** — only its syntax and failure
paths were tested — so read what it prints before applying, and fix it rather
than working around it if it is wrong.

Afterwards, set `WHATSAPP_SERVICE_URL` in the Vercel project to
`https://wa.srv1886744.hstgr.cloud` and redeploy, then scan the WhatsApp QR
code once from the portal's Settings → WhatsApp page.

**3. Known, separate, and blocking Instagram — not your job unless asked.**

The portal has no `META_ACCESS_TOKEN`. The publisher will run every 15 minutes
and post nothing until a long-lived **Page** access token with
`instagram_content_publish` and `instagram_basic` is set in Vercel. A
short-lived *user* token was tried and is the wrong kind.

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
the actual output rather than guessing.

I have root SSH and the Hostinger browser terminal, but I am not a sysadmin.
Assume no knowledge of Docker, reverse proxies or TLS. Tell me exactly where
to click when the step is in a web UI.
