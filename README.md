# Agency ERP — AI-Powered Digital Marketing Agency ERP + CRM + Client Portal

*Powered by Venkat.*

A production-ready SaaS web application that manages the complete workflow of a
digital marketing agency: client onboarding → content planning → raw upload →
editing → AI captions → client approval → scheduling → posting → analytics →
invoicing → payments → reporting.

## Upgrading an existing install

New modules were added after the first release. To bring an already-seeded
database up to date **without losing data**, run the idempotent migration:

```bash
npm run db:migrate
```

This adds: client fields (YouTube, footer/watermark, YT channel id), invoice
processing fee, agency `settings`, per-client AI caption settings, client
fingerprints (auto-detection), the script / thumbnail / version-history
tables, and the **Task Workspace** columns (content brief, role notes, media
links, promotion channel statuses, performance metrics) plus the
`task_comments` discussion table. Fresh installs (`npm run db:reset`) already
include everything.

## What's new — Instagram publishing & WhatsApp approvals

Approved Reels publish themselves, and clients sign them off from WhatsApp.

- **Auto-publishing** — `n8n/01-instagram-auto-publisher.json` polls
  `/api/automation/publish/queue` every 5 minutes, claims a due deliverable,
  builds an Instagram media container, waits for Meta to finish encoding,
  publishes, then stores the media id, permalink and publish timestamp and
  notifies the client by email and WhatsApp.
- **Exactly-once by construction** — n8n can run two executions at once, so the
  claim is settled by a conditional `UPDATE` inside a transaction. Five
  simultaneous claims produce exactly one winner; the rest get a 409 and move
  on. A claim is a 20-minute lease, so a crashed run recovers by itself.
- **Retries in two layers** — n8n retries transient network failures in-node;
  the portal counts attempts on the deliverable (4, then it gives up and tells
  an admin). Meta's permanent error codes (190, 200, 9007…) skip the budget
  entirely, because retrying an expired token never helps.
- **A pasted Page id corrects itself** — people paste the Facebook Page id into
  `ig_user_id` constantly, and stored unchanged it fails at publish time with
  `(#100) Tried accessing nonexisting field (media)`, which names neither the
  problem nor the fix. Saving a client now follows `instagram_business_account`
  to the real account.

### WhatsApp approvals

The client gets the finished MP4 in their own group with a short code, replies
`APPROVE V245` or `CHANGE V245 make the subtitles bigger`, and the portal
records it — status flipped, team notified, board updated live. No login.

- A separate Express service (`whatsapp-service/`) drives WhatsApp Web. It also
  hosts the Socket.IO hub, because Vercel tears functions down between requests
  and cannot hold a socket open.
- **Ambiguity resolves to the safe side** — "approved but change the music" is
  read as a change request, never an approval; reading it the other way
  publishes work the client just objected to. A reply naming another client's
  code is refused, so one group can never approve another's video.
- Replays are no-ops: WhatsApp redelivers after every reconnect, and a repeated
  approval records once and notifies once.
- 32 parser cases cover how clients actually type — lowercase, `#`, hyphens,
  "please", or replying to the video without typing a code at all.
- Live approval board at `/approvals`, a client-facing timeline
  (Uploaded → Sent → Viewed → Approved → Posted), and a full message transcript.

**Setup** — see [`n8n/README.md`](n8n/README.md) and
[`whatsapp-service/README.md`](whatsapp-service/README.md). Start with
`GET /api/automation/health`, which reports which parts are configured.
Auto-publishing is **off by default for every client** and is opted into per
client from the client edit page.

Note on the WhatsApp dependency: whatsapp-web.js is unofficial and against
WhatsApp's ToS; accounts running it do get banned. There is no official
alternative — the Cloud API cannot read or post to groups, which is the whole
mechanism. Use a dedicated number.

## What's new — ERP redesign

The admin app was rebuilt as a modular SaaS-style ERP (white surface, deep
purple primary, sticky header, collapsible sidebar):

- **App shell** — `public/admin.html` + `public/js/erp/` (`core.js` router &
  layout, `pages.js` module pages, `task.js` Task Workspace, `boot.js`), styled
  by `public/css/erp.css`. The client portal keeps `portal.html` + `app.css`.
- **Sidebar** — Dashboard · Today's Tasks · Calendar · Clients · Content ·
  Captions · Approvals · Payments · Analytics · Reports · Library (Scripts,
  Thumbnails, AI Detect) · Administration (Team, Activity, Settings).
- **Top header** — global search (`/`), Quick Add, notifications, profile menu.
- **Task Details Workspace** (`#/tasks/:id`) replaces the old edit popups: a
  full-page surface with tabs — Overview, Content, Media, AI Assistant,
  Approvals, Promotion, Payments, Analytics, Activity, Comments, History.
  Tabs keep unsaved edits (panes stay mounted); **Save Draft** patches only
  changed fields; navigation away warns about unsaved changes.
- **Comments** — Slack-style task discussion with @mentions and URL
  attachments, shared by admins, editors and the client (`task_comments`).
- **Version history** — every tracked field change is stored; the History tab
  shows old→new diffs and supports **Restore** (append-only — restoring adds a
  new version, nothing is ever overwritten).
- **Task timeline** — chronological audit feed per task (created → raw
  uploaded → editing → approval → posted → completed) from `activity_logs`.
- **Granular AI generators** — `POST /api/ai/generate/:id` regenerates one
  output at a time (hooks, hashtags, SEO keywords, thumbnail title, CTA,
  Instagram/Facebook captions, YouTube description, alt text, summary), plus
  the existing full analysis, caption and quality endpoints.
- Full-page **client editor** (`#/clients/:id`) with package, portal access
  and Caption AI settings in one place — no more long popup forms.

## Earlier additions

- **Settings page** (super admin) — company branding, Razorpay keys from the UI,
  invoice prefix, and a **processing fee %** (invoiced as `Package + Package×Fee%`,
  e.g. ₹10,000 → ₹10,260). Branding flows onto every invoice.
- **AI caption engine** — per-client caption settings (language, tone, length,
  emoji style, audience, CTA, SEO keywords, branded hashtags) and a structured
  caption template with `{{placeholders}}` (`{{BusinessName}}`, `{{Phone}}`, …)
  that are substituted at generation time.
- **AI client auto-detection** — identify which client a creative belongs to
  from its logo / watermark / brand text (OpenAI vision when configured, fuzzy
  text match otherwise); confirm unknowns to teach the system (fingerprints).
- **Script Library**, **Thumbnail Library**, and per-deliverable **Version
  History**.
- **YouTube analytics** (YouTube Data API) alongside Instagram, with a platform
  toggle, plus **AI Growth Insights** (best posting time, content type, cadence,
  growth/caption/hashtag suggestions).
- **Weekly calendar** view in addition to monthly.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript (ES6+), Lucide icons |
| Backend | Node.js, Express.js (modular architecture) |
| Database | MySQL 8 (normalized, InnoDB, utf8mb4) |
| Auth | JWT (access + rotating refresh), bcrypt, role-based access control |
| Integrations | OpenAI, Razorpay, Meta Graph API, Google Drive links, SMTP email |

## Quick Start (one-time setup)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
#    Copy .env.example to .env and set at minimum DB_USER / DB_PASSWORD.
#    All integration keys are OPTIONAL — the app runs fully in demo mode without them.

# 3. Create the database + tables
npm run db:setup

# 4. Seed the super admin + demo data
npm run db:seed

# 5. Run
npm start          # production
npm run dev        # development (nodemon)
```

Open http://localhost:4000

### Default logins (from seed)

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@agency.com | Admin@12345 |
| Admin | manager@agency.com | Manager@123 |
| Client | client1@demo.com / client2@demo.com / client3@demo.com | Client@123 |

> Change these in production (`.env` → `SUPERADMIN_*`, then `npm run db:reset`).

## Features

### Admin (agency team)
- **Dashboard** — clients, deliverables, today's/upcoming/overdue tasks, pending
  approvals, pending payments, monthly revenue, client progress, charts,
  mini calendar, recent activity, notification center, global search (`/` key).
- **Clients (CRM)** — full profile (packages, links, renewal), portal login
  provisioning, month progress, archive.
- **Deliverables** — the workflow engine: `pending → waiting_for_raw →
  raw_uploaded → editing → caption_ready → review → approved/changes_requested
  → scheduled → posted → completed` (+ rejected/cancelled with mandatory reason).
- **Calendar** — month view, colour-coded statuses, click-a-day details.
- **Caption Library** — every caption stored permanently, filter by client /
  month / platform / campaign, instant search, one-click copy.
- **AI Studio** (per deliverable) — analyze content, generate caption (with your
  fixed caption structure), hooks, CTA, hashtags, SEO keywords, thumbnail title,
  best posting time, platform suggestion, reel description, alt text, social
  copy, transcript + **AI Quality Check** with a /100 score
  (resolution, aspect ratio, audio, subtitles, hook strength, copyright music).
- **Payments** — invoices (auto-numbered), Razorpay orders, verify signatures,
  manual mark-paid, printable invoice (PDF via print), payment history,
  automatic overdue reminders.
- **Analytics** — followers, reach, impressions, engagement, weekly/monthly
  comparisons, growth charts, best performing content; live Meta Graph sync
  when configured.
- **Reports** — monthly / client / deliverables / promotion / payment /
  performance; Excel (CSV) export + print-to-PDF.
- **Activity Log** — full audit trail of every action with IP.
- **Team** — super admin manages admin accounts.

### Client Portal
- Dashboard with month progress, amount due and approvals waiting.
- Content calendar with assigned dates.
- Upload Google Drive raw links (validated), preview edited files inline,
  view captions, approve or request changes with comments.
- Pay online via Razorpay (falls back to demo checkout without keys),
  invoices with print/PDF, payment history.
- Analytics dashboards and monthly/promotion/payment reports.
- Notification center (in-app + email when SMTP configured).

### Automation (built-in scheduler)
- Hourly: task-due notifications, overdue invoice reminders.
- Daily 02:00: **database backup** (mysqldump → `backups/`, keeps 14) and
  Meta analytics sync.

## Security

- JWT access tokens (15 min) + rotating refresh tokens stored hashed in DB
  (revocable, revoked on password change).
- bcrypt (12 rounds) password hashing; strong password validation.
- Role-based access control (`super_admin`, `admin`, `client`) enforced on
  every route; clients are hard-scoped to their own records.
- Rate limiting (global + stricter on login), Helmet security headers + CSP,
  parameterised SQL everywhere (mysql2 prepared statements), express-validator
  input validation, HTML escaping on render (XSS), CORS allow-list,
  account-enumeration-safe password reset, audit logs.

## Project Structure

```
├── server.js                 # Express bootstrap (security, static, API)
├── database/
│   ├── schema.sql            # Normalized MySQL schema (13 tables)
│   ├── setup.js              # npm run db:setup [--reset]
│   └── seed.js               # npm run db:seed
├── src/
│   ├── config/               # env + MySQL pool
│   ├── middleware/           # auth (JWT/RBAC), validation, errors, audit
│   ├── services/             # ai, razorpay, meta, drive, email, notifications, scheduler
│   ├── modules/              # one folder per feature (routes + handlers)
│   │   ├── auth/ users/ clients/ deliverables/ captions/ ai/
│   │   ├── payments/ analytics/ dashboard/ notifications/
│   │   └── reports/ search/ activity/
│   └── routes.js             # central mount point — add new modules here
└── public/                   # frontend (login, admin SPA, client portal SPA)
    ├── index.html            # login
    ├── admin.html + js/admin.js
    ├── portal.html + js/portal.js
    ├── js/api.js             # fetch + JWT refresh
    ├── js/ui.js              # components: charts, calendar, modals, toasts
    └── css/app.css           # design system (deep purple / white / minimal)
```

**Adding a module:** create `src/modules/<name>/<name>.routes.js`, mount it in
`src/routes.js`, add a nav link + page renderer in the frontend. Nothing in the
core needs to change.

## Integrations (all optional — demo fallbacks included)

| Integration | Env vars | Without keys |
|---|---|---|
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | Deterministic template generator (same response shape) |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Simulated checkout (mock orders) |
| Meta Graph | `META_GRAPH_TOKEN` + per-client `ig_user_id` | Stored snapshot history (seeded) |
| Email | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` | Logged to console, in-app notifications still work |
| Google Drive | link validation works keyless | `GOOGLE_DRIVE_API_KEY` adds file metadata |

## Production Notes

- Set `NODE_ENV=production`, strong `JWT_SECRET`/`JWT_REFRESH_SECRET`, a
  dedicated MySQL user (not root), and `CORS_ORIGIN` to your domain.
- Serve behind HTTPS (nginx/Caddy reverse proxy) — JWTs must not travel over HTTP.
- Ensure `mysqldump` is on PATH for daily backups (or schedule your own).
- `npm run db:backup` runs an on-demand backup.
