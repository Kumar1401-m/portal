#!/usr/bin/env bash
#
# One command to stand the WhatsApp service up on a fresh Ubuntu VM.
#
#   bash deploy/setup.sh wa.your-domain.com
#
# Installs Docker, opens the ports Oracle's images block by default, starts
# the WhatsApp service, and puts Caddy in front for TLS. Safe to run
# again: every step checks before it acts, so a half-finished run is fixed by
# running it a second time rather than by unpicking it.
set -euo pipefail

HOST="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }

if [[ -z "$HOST" ]]; then
  echo "Usage: bash deploy/setup.sh <hostname>"
  echo "  e.g. bash deploy/setup.sh wa.nvkhub.com"
  echo
  echo "The hostname must already point at this machine's public IP."
  exit 1
fi

# ---------------------------------------------------------------------------
say "Checking .env"
# ---------------------------------------------------------------------------
if [[ ! -f "$HERE/.env" ]]; then
  echo "No $HERE/.env found."
  echo
  echo "Copy the one generated on your PC (it already holds the keys the live"
  echo "portal expects), or start from the example:"
  echo
  echo "    cp $HERE/.env.example $HERE/.env && nano $HERE/.env"
  exit 1
fi

# Fill in the hostname rather than making someone edit the file twice.
if grep -q '^WA_HOST=' "$HERE/.env"; then
  sed -i "s|^WA_HOST=.*|WA_HOST=$HOST|" "$HERE/.env"
else
  echo "WA_HOST=$HOST" >> "$HERE/.env"
fi

missing=()
for key in PORTAL_URL PORTAL_API_KEY SERVICE_API_KEY WHATSAPP_SERVICE_TOKEN; do
  grep -qE "^${key}=.+" "$HERE/.env" || missing+=("$key")
done
if (( ${#missing[@]} )); then
  echo "These are still blank in $HERE/.env: ${missing[*]}"
  exit 1
fi
echo "    .env looks complete; WA_HOST set to $HOST"

# ---------------------------------------------------------------------------
say "Docker"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  echo "    already installed ($(docker --version))"
else
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  warn "You were added to the docker group. If the next step fails with a"
  warn "permission error, log out and back in, then re-run this script."
fi

# ---------------------------------------------------------------------------
say "Firewall"
# ---------------------------------------------------------------------------
# Oracle's Ubuntu images ship with iptables rules that drop everything except
# SSH. Opening the security list in the console is necessary but not
# sufficient, and this is the half almost everyone misses.
for port in 80 443; do
  if sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    echo "    port $port already open"
  else
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
    echo "    opened port $port"
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save >/dev/null
else
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1 || true
fi
warn "Also open 80 and 443 in the Oracle console: Networking -> VCN -> Security Lists."

# ---------------------------------------------------------------------------
say "WhatsApp session"
# ---------------------------------------------------------------------------
# Deliberately not copied from the old machine.
#
# The session directory is mostly Chromium profile data — a couple of hundred
# megabytes of cache built by an x86 browser, being handed to an ARM one.
# Scanning the QR takes half a minute and starts from a state that is known to
# be good, which is the better trade. WhatsApp allows several linked devices,
# so doing this does not log the old one out; stop the service on your PC once
# this box is answering.
echo "    you'll scan a QR once — see the logs command printed at the end"

# ---------------------------------------------------------------------------
say "Starting the WhatsApp service"
# ---------------------------------------------------------------------------
cd "$HERE"
docker compose up -d --build
docker compose ps

# ---------------------------------------------------------------------------
say "TLS"
# ---------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null
fi

# The service listens on localhost only; Caddy is what the internet reaches,
# and it obtains and renews the certificate by itself.
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
    reverse_proxy 127.0.0.1:4000
}
CADDY
sudo systemctl restart caddy

# ---------------------------------------------------------------------------
say "Done"
# ---------------------------------------------------------------------------
cat <<NEXT

    WhatsApp service    https://$HOST

Two things left, both in Vercel:

    WHATSAPP_SERVICE_URL             = https://$HOST
    NEXT_PUBLIC_WHATSAPP_SOCKET_URL  = https://$HOST

then redeploy. The keys already match what this box is using.

Watch it come up with:

    docker compose logs -f

The QR appears in those logs and on the portal's Settings -> WhatsApp page.
Scan it once; it persists across restarts and reboots.

Instagram publishing needs nothing here — the portal does it itself. Point a
scheduler at:

    GET https://nvkhub.vercel.app/api/automation/publish/run
    Authorization: Bearer <CRON_SECRET>
NEXT
