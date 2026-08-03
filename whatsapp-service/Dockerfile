# WhatsApp approval service.
#
# whatsapp-web.js drives a real Chromium, so this image is necessarily heavier
# than a normal Node service. Debian slim rather than Alpine: Puppeteer's
# Chromium is glibc-linked and the musl workarounds are more trouble than the
# ~40 MB saved.
FROM node:20-bookworm-slim

# Chromium and the fonts it needs. Without the font packages, any non-Latin
# caption (Telugu, Hindi, emoji) renders as boxes in the WhatsApp Web page —
# which matters here because captions and client names are frequently not
# Latin script.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-core \
      ca-certificates \
      dumb-init \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libasound2 \
      libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Use the distro Chromium instead of downloading a second copy at install time.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Dependencies first, so a code change doesn't re-install node_modules.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# The session lives here and MUST be a mounted volume — see compose. Without
# one, every container restart discards the login and needs a QR re-scan,
# which nobody notices until an approval goes unanswered.
RUN mkdir -p /app/.wwebjs_auth && chown -R node:node /app

# Chromium as root refuses to start without --no-sandbox, and running a browser
# that renders untrusted remote content as root is a bad idea regardless.
USER node

EXPOSE 4000

# dumb-init reaps the zombie processes Chromium leaves behind; without it they
# accumulate until the container hits its PID limit, days into a deployment.
ENTRYPOINT ["dumb-init", "--"]

# Reports liveness of the SERVICE, not the WhatsApp session. A logout must not
# restart the container — that would throw away a working browser and fix
# nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
