#!/usr/bin/env bash
#
# Put the WhatsApp service on a Hostinger VPS that is already running n8n.
#
#   bash deploy/hostinger.sh              # look only, change nothing
#   bash deploy/hostinger.sh --apply      # actually do it
#
# The box already has something on 80 and 443 for n8n. Installing a second
# web server would take those ports away from it, so this finds what is there
# and puts the WhatsApp service behind it instead.
#
# Safe by default: with no --apply it inspects and prints a plan. Nothing it
# does later touches the n8n container or the proxy's own configuration
# beyond adding one site, and the proxy config is backed up before editing.
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DEFAULT="wa.$(hostname -f 2>/dev/null || echo srv.local)"
WA_HOST="${WA_HOST:-$HOST_DEFAULT}"
PORT=4000

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }
die()  { printf '\033[31m==> %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
bold "What is running"
# ---------------------------------------------------------------------------
command -v docker >/dev/null || die "Docker is not installed. This script expects Hostinger's n8n template."
# Installed and running are different things, and the difference shows up as
# an abort with no explanation three lines later.
docker info >/dev/null 2>&1 || die "Docker is installed but not responding. Try: systemctl start docker"

docker ps --format '    {{.Names}}  |  {{.Image}}  |  {{.Ports}}' || true

# Which container is holding the web ports. Matching on the published port
# rather than the image name, because the image tells you what someone chose
# to run and the port tells you what is actually in the way.
PROXY_LINE="$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -E ':(80|443)->' || true)"
PROXY_NAME="$(cut -f1 <<<"$PROXY_LINE" | head -1)"
PROXY_IMAGE="$(cut -f2 <<<"$PROXY_LINE" | head -1)"

KIND="none"
if [[ -n "$PROXY_IMAGE" ]]; then
  case "${PROXY_IMAGE,,}" in
    *traefik*)                KIND="traefik" ;;
    *caddy*)                  KIND="caddy" ;;
    *nginx-proxy-manager*|*jc21*) KIND="npm" ;;
    *nginx*)                  KIND="nginx" ;;
    *)                        KIND="unknown" ;;
  esac
fi

bold "Findings"
if [[ "$KIND" == "none" ]]; then
  info "Nothing is publishing 80/443 from Docker."
  if ss -tlnp 2>/dev/null | grep -qE ':(80|443)\b'; then
    warn "But something outside Docker is listening. Host processes on those ports:"
    ss -tlnp 2>/dev/null | grep -E ':(80|443)\b' | sed 's/^/      /'
    KIND="host"
  else
    info "The ports are free — a standalone Caddy can take them."
  fi
else
  info "Proxy container : $PROXY_NAME"
  info "Image           : $PROXY_IMAGE"
  info "Identified as   : $KIND"
fi
info "WhatsApp host   : $WA_HOST"
info "Service port    : 127.0.0.1:$PORT"

# ---------------------------------------------------------------------------
bold "Checks"
# ---------------------------------------------------------------------------
[[ -f "$HERE/.env" ]] || die "$HERE/.env is missing. Copy it up from your PC — it holds the keys the portal expects."

missing=()
for key in PORTAL_URL WA_PORTAL_KEY SERVICE_API_KEY WHATSAPP_SERVICE_TOKEN; do
  grep -qE "^${key}=.+" "$HERE/.env" || missing+=("$key")
done
(( ${#missing[@]} )) && die "Blank in .env: ${missing[*]}"
info ".env looks complete"

resolved="$(getent hosts "$WA_HOST" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [[ -z "$resolved" ]]; then
  warn "$WA_HOST does not resolve yet. TLS cannot be issued until it does."
else
  info "$WA_HOST resolves to $resolved"
fi

# ---------------------------------------------------------------------------
bold "Plan"
# ---------------------------------------------------------------------------
case "$KIND" in
  traefik)
    info "1. Start the WhatsApp service attached to $PROXY_NAME's network,"
    info "   labelled so Traefik routes $WA_HOST to it on port $PORT."
    info "2. Traefik issues the certificate itself. n8n is untouched." ;;
  caddy)
    info "1. Start the WhatsApp service on 127.0.0.1:$PORT."
    info "2. Add one site block for $WA_HOST to the Caddyfile and reload."
    info "   The existing n8n site block is left exactly as it is." ;;
  none)
    info "1. Start the WhatsApp service on 127.0.0.1:$PORT."
    info "2. Install Caddy and give it $WA_HOST — nothing else wants those ports." ;;
  *)
    warn "This script will not guess at a $KIND setup."
    warn "Start the service with: docker compose -f $HERE/docker-compose.yml up -d"
    warn "then point $WA_HOST at 127.0.0.1:$PORT in that proxy by hand."
    ;;
esac

if (( ! APPLY )); then
  bold "Nothing was changed"
  info "Re-run with --apply to carry the plan out:"
  info "    bash deploy/hostinger.sh --apply"
  exit 0
fi

# ---------------------------------------------------------------------------
bold "Starting the WhatsApp service"
# ---------------------------------------------------------------------------
sed -i "s|^WA_HOST=.*|WA_HOST=$WA_HOST|" "$HERE/.env" 2>/dev/null || echo "WA_HOST=$WA_HOST" >> "$HERE/.env"

# Traefik needs labels and a second network, and neither can be added to a
# running container — so under Traefik the start happens once, below, with the
# override in place, rather than starting here and immediately recreating.
if [[ "$KIND" != "traefik" ]]; then
  docker compose -f "$HERE/docker-compose.yml" up -d --build
  info "started"
else
  info "deferred until the Traefik labels are written"
fi

# ---------------------------------------------------------------------------
case "$KIND" in
  traefik)
    bold "Wiring it into Traefik"

    NET="$(docker inspect "$PROXY_NAME" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
    [[ -n "$NET" ]] || die "Could not read $PROXY_NAME's network."
    info "network      : $NET"

    # Copy n8n's own routing settings rather than guessing at them. The
    # certresolver and entrypoint names are chosen by whoever wrote the n8n
    # stack; a wrong guess produces a router Traefik accepts and never serves,
    # which fails as a certificate error hours later rather than as an error
    # here.
    LABELS="$(docker ps -q | xargs -r -n1 docker inspect -f '{{json .Config.Labels}}' 2>/dev/null | tr ',' '\n')"
    RESOLVER="$(grep -oE 'certresolver=[A-Za-z0-9_-]+' <<<"$LABELS" | head -1 | cut -d= -f2)"
    ENTRY="$(grep -oE 'entrypoints=[A-Za-z0-9_,-]+' <<<"$LABELS" | head -1 | cut -d= -f2 | cut -d, -f1)"
    [[ -n "$RESOLVER" ]] || { RESOLVER="mytlschallenge"; warn "no certresolver found on any container — assuming $RESOLVER"; }
    [[ -n "$ENTRY" ]]    || { ENTRY="websecure";        warn "no entrypoint found on any container — assuming $ENTRY"; }
    info "certresolver : $RESOLVER"
    info "entrypoint   : $ENTRY"

    # An override file rather than edits to docker-compose.yml: the committed
    # file stays generic, and everything server-specific — the network name
    # this box happens to use, the resolver n8n happens to be configured with
    # — lives in a file that is generated and can be regenerated.
    OVERRIDE="$HERE/docker-compose.override.yml"
    cat > "$OVERRIDE" <<EOF
# Generated by deploy/hostinger.sh — safe to delete and regenerate.
# Routes $WA_HOST to the WhatsApp service through the Traefik that is
# already serving n8n on this box.
services:
  whatsapp-service:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wa.rule=Host(\`$WA_HOST\`)"
      - "traefik.http.routers.wa.entrypoints=$ENTRY"
      - "traefik.http.routers.wa.tls.certresolver=$RESOLVER"
      - "traefik.http.services.wa.loadbalancer.server.port=$PORT"
    networks:
      - default
      - proxy
networks:
  proxy:
    name: $NET
    external: true
EOF
    info "wrote $(basename "$OVERRIDE")"

    # Recreate so the labels and the extra network actually take: neither can
    # be added to a container that is already running.
    docker compose -f "$HERE/docker-compose.yml" -f "$OVERRIDE" up -d --build
    info "recreated on Traefik's network"
    ;;

  caddy|none)
    bold "TLS with Caddy"
    if [[ "$KIND" == "none" ]] && ! command -v caddy >/dev/null 2>&1; then
      info "installing Caddy"
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      apt-get update >/dev/null && apt-get install -y caddy >/dev/null
    fi

    CADDYFILE=/etc/caddy/Caddyfile
    if [[ "$KIND" == "caddy" ]]; then
      warn "Caddy is running in Docker as '$PROXY_NAME'. Its Caddyfile is inside that"
      warn "container; find it with:  docker inspect $PROXY_NAME -f '{{json .Mounts}}'"
      warn "Add this block to it and reload:"
    else
      [[ -f "$CADDYFILE" ]] && cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)" && info "backed up $CADDYFILE"
    fi

    BLOCK="$WA_HOST {
    reverse_proxy 127.0.0.1:$PORT
}"
    if [[ "$KIND" == "none" ]]; then
      grep -q "^$WA_HOST" "$CADDYFILE" 2>/dev/null || printf '\n%s\n' "$BLOCK" >> "$CADDYFILE"
      systemctl reload caddy || systemctl restart caddy
      info "Caddy serving $WA_HOST"
    else
      printf '\n%s\n\n' "$BLOCK"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
bold "Next"
# ---------------------------------------------------------------------------
COMPOSE="-f $HERE/docker-compose.yml"
[[ -f "$HERE/docker-compose.override.yml" ]] && COMPOSE="$COMPOSE -f $HERE/docker-compose.override.yml"
info "1. Watch it come up:   docker compose $COMPOSE logs -f"
info "2. Check it answers:   curl -s https://$WA_HOST/health"
info "3. In Vercel, set WHATSAPP_SERVICE_URL=https://$WA_HOST and redeploy."
info "4. Portal → Settings → WhatsApp → scan the QR once, on the phone that owns the number."
warn "Scan it once and leave it. Repeated restarts leave orphaned Chromium"
warn "processes sharing one session, which logs the account out."
