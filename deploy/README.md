# Automation host

The portal runs on Vercel, which is serverless: nothing stays alive between
requests. Two things need to stay alive.

| | Why it can't be serverless |
|---|---|
| **n8n** | Publishing has to be checked every few minutes. Vercel's free plan allows one scheduled run a day. |
| **whatsapp-service** | It holds a logged-in WhatsApp Web session in a real browser. That session dies with the process. |

Both fit comfortably on one small always-free VM.

## Cost

Nothing, if you use a free tier that stays free.

| | Cost | Watch out for |
|---|---|---|
| Oracle Cloud Always Free | ₹0 forever | Signup wants a card for identity; free-tier ARM capacity in some regions is scarce |
| Instagram publishing | ₹0 | Meta charges nothing to publish |
| whatsapp-service | ₹0 | No Meta fees — but see the warning below |
| Render / Railway free tiers | — | Both sleep when idle or have expired free plans; a sleeping container loses the WhatsApp session |

**Sizing:** 1 ARM core / 6 GB is comfortable. Chromium alone wants ~800 MB.
Oracle's free allowance is 4 cores / 24 GB, so one instance covers this with
room to spare.

## The WhatsApp trade-off, plainly

`whatsapp-service` drives a real WhatsApp account through an unofficial
library. It costs nothing and can send video, which the official API charges
for. In exchange:

- Meta can ban the number. It is against their terms.
- **Use a separate SIM, not your personal or main business number.**
- A WhatsApp Web update can break the library until it's patched upstream.

If that risk is unacceptable later, the official Cloud API is a drop-in
replacement for the notification: change one node's URL back and set the Meta
credentials. The approval flow (clients replying APPROVE / CHANGE) is
whatsapp-web.js only — the Cloud API cannot read a group.

## Setup

### The short version

Everything below is automated by `setup.sh`. On a fresh Ubuntu VM:

```bash
git clone <your repo> nvkhub && cd nvkhub
# copy deploy/.env across from your PC — it already holds the right keys
bash deploy/setup.sh n8n.your-domain.com
```

It installs Docker, opens the ports Oracle's image blocks, starts both
containers, and configures Caddy for TLS. Run it again any time; every step
checks before it acts.

The rest of this file explains what it does and why, for when something needs
unpicking.

### 1. The machine

Create an **Ampere (ARM) Always Free** instance on Oracle Cloud running Ubuntu
22.04, then open ports 80 and 443 — both in the VCN security list *and* in the
instance firewall, which Oracle images enable by default and which catches
almost everyone:

```bash
sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Nothing else is exposed: both containers bind to `127.0.0.1` and are reached
only through the reverse proxy.

### 2. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

### 3. This repo

```bash
git clone <your repo> nvkhub && cd nvkhub/deploy
cp .env.example .env
nano .env            # fill in every blank; read the comments, the two
                     # portal keys are different on purpose
docker compose up -d
```

### 4. Scan the QR

```bash
docker compose logs -f whatsapp-service
```

Scan it from the phone holding the WhatsApp number. The session persists in a
named volume, so this is a one-time step — unless the volume is deleted, which
logs the account out silently.

### 5. TLS

Point a subdomain at the VM's public IP, then:

```bash
sudo apt install -y caddy
echo "$N8N_HOST { reverse_proxy 127.0.0.1:5678 }" | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy obtains and renews the certificate on its own. n8n's editor is now
reachable over HTTPS, behind the basic-auth credentials from `.env`.

### 6. Import the workflow

Open n8n → **Import from File** → `n8n/01-instagram-auto-publisher.json` →
**Activate**.

### 7. Tell the portal where the service is

In Vercel, set:

```
WHATSAPP_SERVICE_URL   = https://<the service's public URL>
WHATSAPP_SERVICE_TOKEN = same value as SERVICE_API_KEY here
WHATSAPP_SERVICE_KEY   = same value as PORTAL_API_KEY here
N8N_API_KEY            = same value as N8N_PORTAL_KEY here
```

Redeploy. `vercel env add` then `vercel --prod`.

## Checking it works

Before waiting on a real post:

```bash
# The portal answers the automation, using the key n8n will send
curl -H "Authorization: Bearer $N8N_PORTAL_KEY" \
     "$PORTAL_URL/api/automation/publish/queue?limit=1"

# The WhatsApp service is connected
curl -H "Authorization: Bearer $SERVICE_API_KEY" \
     http://127.0.0.1:4000/api/status
```

A queue response of `{"ok":true,"count":0,...}` is correct when nothing is due.
`{"ok":false,"error":"Unauthorized"}` means the keys don't match — check which
of `N8N_API_KEY` / `ZAPIER_API_KEY` the portal actually has set.

## What still has to be true

Automation publishes nothing on its own if any of these is missing:

- A **long-lived** Meta token with `instagram_content_publish`.
- The client's `ig_user_id` is the **Instagram** account id, not a Facebook
  Page id. The portal translates a Page id automatically, but a wrong id fails
  quietly at the container step.
- The client has **auto-publish enabled** and the task is **approved and
  scheduled** — the queue only ever returns work that satisfies all three.
