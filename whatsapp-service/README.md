# WhatsApp approval service

Clients approve finished videos by replying in their own WhatsApp group:

```
📹 Video Ready
Video ID: V245
Please review and reply:
✅ APPROVE V245
📝 CHANGE V245 (then your notes)
```

The client types `APPROVE V245` and the portal records it — status flipped,
team notified, dashboard updated live, no login required from the client.

## Read this before you deploy it

**whatsapp-web.js is unofficial.** It drives WhatsApp Web through a real
Chromium and is against WhatsApp's Terms of Service. Accounts running it do get
banned. There is no official alternative for this use case — the WhatsApp Cloud
API cannot read or post to groups, which is the entire mechanism here.

Mitigations that actually matter:

- **Use a dedicated number**, not the one your business depends on.
- Keep the throttle (`SEND_THROTTLE_MS`) — bursts look like spam.
- Don't raise `SEND_MAX_ATTEMPTS` beyond a handful.
- Expect to re-scan the QR occasionally.

If the number is banned, the portal keeps working — only automated approvals
stop, and the existing in-portal approval flow still functions.

## How it fits together

```
Designer uploads video  ──►  Portal (Vercel)
                                  │  admin clicks "Send for approval"
                                  ▼
                        WhatsApp service (this app, a VPS)
                                  │  sends the MP4 from R2 into the group
                                  ▼
                        Client's WhatsApp group
                                  │  "APPROVE V245"
                                  ▼
                        WhatsApp service parses it
                                  │  POST /api/whatsapp/approve
                                  ▼
                        Portal records it  ──►  Socket.IO  ──►  dashboard updates
```

The service holds **no database**. The portal is the system of record; this is
a transport that happens to be stateful about one browser session.

**Socket.IO lives here, not in the portal.** Vercel tears functions down
between requests and cannot hold a WebSocket open. This process is long-lived
by necessity, so the dashboard connects to it directly.

## Setup

### 1. Migrate the portal database

```bash
node database/migrate.js
```

Or, with no shell: portal → **Settings → Database → Add them**.

### 2. Generate two keys

Two, pointing in opposite directions, so either can be rotated alone:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # PORTAL_API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SERVICE_API_KEY
```

| Portal env | Service env | Direction |
| --- | --- | --- |
| `WHATSAPP_SERVICE_KEY` | `PORTAL_API_KEY` | service → portal |
| `WHATSAPP_SERVICE_TOKEN` | `SERVICE_API_KEY` | portal → service |

Also set in the portal:

```env
WHATSAPP_SERVICE_URL=https://wa.your-domain.com
NEXT_PUBLIC_WHATSAPP_SOCKET_URL=https://wa.your-domain.com
```

`NEXT_PUBLIC_` is required — the browser opens the socket, so that value has to
reach the client bundle.

### 3. Start it

```bash
cd whatsapp-service
cp .env.example .env      # fill in the values above
docker compose up -d
docker compose logs -f    # watch for the QR prompt
```

### 4. Scan the QR

Portal → **Settings → WhatsApp**. A QR appears; on the phone that will send
approvals: WhatsApp → Settings → Linked devices → Link a device.

The code expires in about a minute — press **Reconnect** for a fresh one.

Once scanned the session persists in the `wa-session` volume. Restarts and
redeploys do **not** need another scan.

### 5. Link each client to a group

Same page, **Client groups**. Groups are picked from the live list the account
is actually in — never typed, because a mistyped id saves happily and then
silently matches nothing.

Create the group in WhatsApp first and add the agency number to it.

## Daily use

1. Designer uploads the finished video (goes to R2).
2. Admin opens the task → **Send for approval**.
3. The client gets the video in their group with a code.
4. They reply `APPROVE V245` or `CHANGE V245 make the subtitles bigger`.
5. The dashboard updates live; the team is notified.

### What the parser accepts

Clients are on phones, not following a spec, so it's forgiving about
everything that doesn't change the meaning:

```
APPROVE V245      approve v245      Approve #V245      approved V-245
ok approve v245   please approve V245
CHANGE V245 increase subtitle size
change v245
revise V245 shorten the intro
```

Replying **directly to the video message** works without typing the code at
all — it's recovered from the quoted caption.

**One rule is strict**: `approved but change the music` is read as a **change
request**, never an approval. Ambiguity resolves towards the safe side, because
reading that as approval publishes work the client just objected to.

A command with no identifiable video gets a reply asking which one, rather than
a guess.

## Safety properties

Verified by `scratchpad/test-whatsapp-flow.js` (24 assertions):

- **A group can only approve its own videos.** Typing another client's code in
  your group is refused and named.
- **Replays are no-ops.** WhatsApp redelivers after a reconnect; the same
  approval arriving twice records once and notifies once.
- **A late receipt can't un-approve.** A delivery receipt arriving after the
  client answered doesn't regress the status.
- **Unknown codes are refused, not guessed.**

## Operating it

```bash
docker compose ps                       # is it up?
docker compose logs -f --tail=100       # what's it doing?
docker compose restart                  # session survives
curl localhost:4000/health              # liveness
```

**Health returns 200 even when WhatsApp is disconnected**, deliberately. The
*service* is healthy; the *session* isn't. Returning 503 would make Docker
restart the container on a logout, throwing away a working browser and fixing
nothing.

### Common problems

**QR keeps reappearing.** The session volume isn't persisting. Check
`docker volume ls` for `wa-session` and that `WA_SESSION_PATH` matches the
mount point.

**"Target closed" / Chromium crashes.** `/dev/shm` too small. `shm_size: 1gb`
is in the compose file — confirm it applied.

**Sends fail with "too large".** WhatsApp's practical ceiling is ~16 MB. The
service refuses above `SEND_MAX_MEDIA_BYTES` before Chromium is asked to hold
the bytes. Compress the video.

**Approvals aren't recorded.** Check the group is linked (Settings → WhatsApp)
and that `PORTAL_API_KEY` here equals `WHATSAPP_SERVICE_KEY` there. The service
logs every callback failure.

**Dashboard isn't live.** The browser needs to reach `NEXT_PUBLIC_WHATSAPP_SOCKET_URL`
directly, and that origin must be in `CORS_ORIGINS`. Over HTTPS the socket URL
must also be HTTPS — a browser refuses a mixed-content WebSocket.

## Reverse proxy

The port binds to `127.0.0.1` on purpose. Terminate TLS in front of it, and
pass WebSocket upgrades through or Socket.IO will fall back to polling forever:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 300s;   # video sends are slow
}
```

## API

Authenticated with `Authorization: Bearer <SERVICE_API_KEY>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness (unauthenticated) |
| GET | `/api/status` | Session state |
| GET | `/api/qr` | QR image; 409 when already connected |
| POST | `/api/reconnect` | Re-establish the session |
| POST | `/api/logout` | Discard the session (needs `{"confirm":true}`) |
| GET | `/api/groups` | Groups this account is in |
| POST | `/api/send-video` | Send an approval video |
| POST | `/api/send-text` | Plain text into a group |

Callbacks into the portal, with `Authorization: Bearer <PORTAL_API_KEY>`:
`/api/whatsapp/approve`, `/message`, `/send-status`, `/session`.

## Tests

```bash
node src/lib/command-parser.test.js   # 32 parser cases
```

The parser is the only place a misread turns into the wrong video going live,
so the ambiguous cases are the point of that file.
