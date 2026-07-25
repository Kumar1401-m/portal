/**
 * Deliverables module — the content workflow engine.
 *
 * Workflow: pending → waiting_for_raw → raw_uploaded → editing → caption_ready
 *           → review → (approved | changes_requested → resolved → review)
 *           → scheduled → posted → completed  (rejected/cancelled need a reason)
 */
'use strict';

const express = require('express');
const { body, param } = require('express-validator');

const { query, queryOne } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination, pick } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const { notifyAdmins, notifyClient } = require('../../services/notificationService');
const drive = require('../../services/driveService');
const { PLATFORMS, STATUS_LIST, REASON_REQUIRED } = require('../../utils/constants');

const router = express.Router();
router.use(authenticate);

/** Statuses a client is allowed to set (everything else is admin-only). */
const CLIENT_ALLOWED = ['raw_uploaded', 'approved', 'changes_requested'];

const monthKeyOf = (dateStr) => (dateStr ? String(dateStr).slice(0, 7) : null);

/** Load a deliverable and enforce ownership for client users. */
async function loadScoped(req, id) {
  const row = await queryOne(
    `SELECT d.*, c.company_name, c.user_id AS client_user_id, c.business_type
     FROM deliverables d JOIN clients c ON c.id = d.client_id WHERE d.id = ?`,
    [id]
  );
  if (!row) throw ApiError.notFound('Deliverable not found');
  if (req.user.role === 'client' && req.user.clientId !== row.client_id) throw ApiError.forbidden();
  if (req.user.role === 'poster_designer' && row.assigned_to !== req.user.id) throw ApiError.forbidden();
  return row;
}

/** Fields captured in content_versions — nothing is ever overwritten silently. */
const VERSIONED_FIELDS = [
  'title', 'description', 'caption', 'content_hook', 'ai_prompt', 'custom_instructions',
  'writer_notes', 'videographer_notes', 'editor_notes', 'client_notes',
  'raw_drive_link', 'edited_link', 'thumbnail_url', 'subtitle_link',
];

/** Record before/after snapshots for tracked fields (version history). */
async function recordVersions(req, deliverable, data) {
  const tracked = VERSIONED_FIELDS;
  for (const f of tracked) {
    if (data[f] === undefined) continue;
    const oldVal = deliverable[f] || null;
    const newVal = data[f] === '' ? null : data[f];
    if (String(oldVal || '') === String(newVal || '')) continue;
    await query(
      `INSERT INTO content_versions (deliverable_id, field, old_value, new_value, changed_by, actor_name)
       VALUES (?,?,?,?,?,?)`,
      [deliverable.id, f, oldVal, newVal, req.user.id, req.user.name]
    );
  }
}

/* GET /api/deliverables — filterable list (admin sees all, client sees own) */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 25);
    const conds = [];
    const params = [];

    if (req.user.role === 'client') {
      conds.push('d.client_id = ?');
      params.push(req.user.clientId || 0);
    } else if (req.user.role === 'poster_designer') {
      // Poster designers only ever see tasks assigned to them (optionally narrowed to one client).
      conds.push('d.assigned_to = ?');
      params.push(req.user.id);
      if (req.query.client_id) { conds.push('d.client_id = ?'); params.push(Number(req.query.client_id)); }
    } else if (req.query.client_id) {
      conds.push('d.client_id = ?');
      params.push(Number(req.query.client_id));
    } else {
      // Admin default worklists: hide tasks belonging to archived (churned) clients.
      conds.push("c.status != 'churned'");
    }
    if (req.query.status) {
      // Accept a single status or a comma-separated list (e.g. content_review,review).
      const list = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > 1) {
        conds.push(`d.status IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      } else {
        conds.push('d.status = ?');
        params.push(list[0]);
      }
    }
    if (req.query.platform) { conds.push('d.platform = ?'); params.push(req.query.platform); }
    if (req.query.not_platform) { conds.push('d.platform != ?'); params.push(req.query.not_platform); }
    if (req.query.video_type) { conds.push('d.video_type = ?'); params.push(req.query.video_type); }
    if (req.query.not_video_type) {
      conds.push('(d.video_type IS NULL OR d.video_type != ?)'); params.push(req.query.not_video_type);
    }
    if (req.query.month) { conds.push('d.month_key = ?'); params.push(req.query.month); }
    if (req.query.approval) { conds.push('d.approval_status = ?'); params.push(req.query.approval); }
    if (req.query.due === 'today') conds.push('d.due_date = CURDATE()');
    if (req.query.due === 'overdue') {
      conds.push("d.due_date < CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')");
    }
    if (req.query.due === 'upcoming') conds.push('d.due_date > CURDATE()');
    if (req.query.q) {
      conds.push('(d.title LIKE ? OR d.caption LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS n FROM deliverables d JOIN clients c ON c.id = d.client_id ${where}`, params
    );
    const rows = await query(
      `SELECT d.*, c.company_name, c.company_logo_url,
              c.business_type, c.contact_person, c.phone, c.website,
              c.instagram_link, c.facebook_link, c.youtube_link
       FROM deliverables d JOIN clients c ON c.id = d.client_id
       ${where}
       ORDER BY d.due_date IS NULL, d.due_date ASC, FIELD(d.priority,'urgent','high','medium','low'), d.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* GET /api/deliverables/calendar?month=YYYY-MM — calendar feed */
router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const conds = ['d.month_key = ?'];
    const params = [month];
    if (req.user.role === 'client') {
      conds.push('d.client_id = ?');
      params.push(req.user.clientId || 0);
    } else if (req.query.client_id) {
      conds.push('d.client_id = ?');
      params.push(Number(req.query.client_id));
    }
    const rows = await query(
      `SELECT d.id, d.title, d.platform, d.due_date, d.status, d.priority, c.company_name
       FROM deliverables d JOIN clients c ON c.id = d.client_id
       WHERE ${conds.join(' AND ')} ORDER BY d.due_date ASC`,
      params
    );
    ok(res, { month, items: rows });
  })
);

/* GET /api/deliverables/:id — detail incl. AI analysis, approvals, feedback */
router.get(
  '/:id',
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const [ai, approvals, feedback, versions, comments, people, client] = await Promise.all([
      queryOne('SELECT * FROM ai_analysis WHERE deliverable_id = ? ORDER BY id DESC LIMIT 1', [d.id]),
      query(
        `SELECT a.*, u.name AS actor_name FROM approvals a
         LEFT JOIN users u ON u.id = a.acted_by
         WHERE a.deliverable_id = ? ORDER BY a.id DESC`, [d.id]
      ),
      query(
        `SELECT f.*, u.name AS author_name FROM feedback f
         LEFT JOIN users u ON u.id = f.author_id
         WHERE f.deliverable_id = ? ORDER BY f.id ASC`, [d.id]
      ),
      query(
        `SELECT id, field, old_value, new_value, actor_name, created_at
         FROM content_versions WHERE deliverable_id = ? ORDER BY id DESC LIMIT 100`, [d.id]
      ),
      query(
        `SELECT tc.*, u.name AS author_name FROM task_comments tc
         LEFT JOIN users u ON u.id = tc.author_id
         WHERE tc.deliverable_id = ? ORDER BY tc.id ASC`, [d.id]
      ),
      query(
        `SELECT u.name, u.id, 'assigned' AS rel FROM users u
         JOIN deliverables dd ON dd.assigned_to = u.id AND dd.id = ?
         UNION ALL
         SELECT u.name, u.id, 'creator' FROM users u
         JOIN deliverables dd ON dd.created_by = u.id AND dd.id = ?
         UNION ALL
         SELECT u.name, u.id, 'poster' FROM users u
         JOIN deliverables dd ON dd.posted_by = u.id AND dd.id = ?`, [d.id, d.id, d.id]
      ),
      queryOne(
        `SELECT company_name, company_logo_url, contact_person, phone, email, website,
                instagram_link, facebook_link, youtube_link, business_type,
                monthly_package, package_amount, payment_plan, status AS client_status
         FROM clients WHERE id = ?`, [d.client_id]
      ),
    ]);
    const nameOf = (rel) => (people.find((p) => p.rel === rel) || {}).name || null;
    ok(res, {
      ...d,
      raw_preview: drive.previewUrl(d.raw_drive_link),
      edited_preview: drive.previewUrl(d.edited_link),
      ai_analysis: ai,
      approvals,
      feedback,
      versions,
      comments,
      client,
      assigned_to_name: nameOf('assigned'),
      created_by_name: nameOf('creator'),
      posted_by_name: nameOf('poster'),
    });
  })
);

/* POST /api/deliverables — create (admin). Supports bulk via items[]. */
router.post(
  '/',
  requireAdmin,
  validate([
    body('client_id').isInt().withMessage('client_id required'),
    body('items').optional().isArray({ min: 1, max: 100 }),
    body('title').if(body('items').not().exists()).trim().isLength({ min: 2, max: 255 }),
    body('platform').optional().isIn(PLATFORMS),
    body('due_date').optional({ values: 'falsy' }).isDate(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  ]),
  asyncHandler(async (req, res) => {
    const clientId = Number(req.body.client_id);
    const client = await queryOne('SELECT id, company_name, designer_id FROM clients WHERE id = ?', [clientId]);
    if (!client) throw ApiError.notFound('Client not found');

    const items = req.body.items || [pick(req.body, [
      'title', 'description', 'platform', 'content_type', 'due_date', 'priority', 'campaign',
    ])];
    const ids = [];
    for (const item of items) {
      if (!item.title || String(item.title).trim().length < 2) continue;
      const r = await query(
        // New tasks start at content-draft: the team writes the content, then
        // sends it to the client for the first approval gate (content_review).
        // assigned_to inherits the client's default designer (set at onboarding).
        `INSERT INTO deliverables
         (client_id, title, description, platform, content_type, due_date, priority, campaign,
          status, month_key, created_by, assigned_to)
         VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`,
        [
          clientId,
          String(item.title).trim(),
          item.description || null,
          PLATFORMS.includes(item.platform) ? item.platform : 'other',
          item.content_type || null,
          item.due_date || null,
          ['low', 'medium', 'high', 'urgent'].includes(item.priority) ? item.priority : 'medium',
          item.campaign || null,
          monthKeyOf(item.due_date) || new Date().toISOString().slice(0, 7),
          req.user.id,
          client.designer_id || null,
        ]
      );
      ids.push(r.insertId);
    }
    if (!ids.length) throw ApiError.badRequest('No valid items to create');

    audit(req, 'create', 'deliverable', ids[0], `Created ${ids.length} deliverable(s) for ${client.company_name}`);
    notifyClient(
      clientId, 'general', 'New content scheduled',
      `${ids.length} new deliverable(s) added to your content plan.`, '#/calendar'
    );
    ok(res, { ids }, `${ids.length} deliverable(s) created`, 201);
  })
);

/* PATCH /api/deliverables/:id — edit fields (admin) */
router.patch(
  '/:id',
  requireAdmin,
  validate([
    param('id').isInt(),
    body('title').optional().trim().isLength({ min: 2, max: 255 }),
    body('platform').optional().isIn(PLATFORMS),
    body('due_date').optional({ values: 'falsy' }).isDate(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
    body('caption').optional({ values: 'falsy' }).isLength({ max: 5000 }),
    body('edited_link').optional({ values: 'falsy' }).isURL(),
    body('raw_drive_link').optional({ values: 'falsy' }).isURL(),
    body('thumbnail_url').optional({ values: 'falsy' }).isURL(),
    body('subtitle_link').optional({ values: 'falsy' }).isURL(),
    body('scheduled_at').optional({ values: 'falsy' }).isISO8601(),
    ...['instagram_status', 'facebook_status', 'youtube_status'].map((f) =>
      body(f).optional().isIn(['not_posted', 'scheduled', 'posted', 'failed'])),
    ...['metric_views', 'metric_reach', 'metric_likes', 'metric_comments', 'metric_shares', 'metric_saves'].map((f) =>
      body(f).optional({ values: 'falsy' }).isInt({ min: 0 })),
    body('content_rating').optional({ values: 'falsy' }).isInt({ min: 1, max: 5 }),
    body('assigned_to').optional({ values: 'falsy' }).isInt(),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const data = pick(req.body, [
      'title', 'description', 'platform', 'content_type', 'due_date', 'priority',
      'caption', 'edited_link', 'raw_drive_link', 'thumbnail_url', 'subtitle_link',
      'campaign', 'scheduled_at', 'assigned_to',
      // Task Workspace — content brief + role notes
      'content_hook', 'video_type', 'promotion_type', 'content_category', 'language',
      'target_audience', 'video_duration', 'ai_prompt', 'custom_instructions',
      'writer_notes', 'videographer_notes', 'editor_notes', 'client_notes',
      // Promotion & performance
      'posted_by', 'instagram_status', 'facebook_status', 'youtube_status',
      'metric_views', 'metric_reach', 'metric_likes', 'metric_comments', 'metric_shares', 'metric_saves',
      'content_rating',
    ]);
    if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');
    if (data.due_date) data.month_key = monthKeyOf(data.due_date);
    if (data.scheduled_at) data.scheduled_at = data.scheduled_at.replace('T', ' ').slice(0, 19);

    await recordVersions(req, d, data); // capture changes before applying

    const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
    await query(`UPDATE deliverables SET ${sets} WHERE id = ?`, [
      ...Object.keys(data).map((k) => (data[k] === '' ? null : data[k])), d.id,
    ]);

    // Auto-advance: adding an edited link while editing moves it forward.
    if (data.edited_link && ['raw_uploaded', 'editing'].includes(d.status)) {
      await query("UPDATE deliverables SET status = 'caption_ready' WHERE id = ?", [d.id]);
      notifyClient(d.client_id, 'edited_ready', 'Edited content ready',
        `"${d.title}" has been edited and is being prepared for your review.`, `#/content/${d.id}`);
    }
    audit(req, 'update', 'deliverable', d.id, `Updated "${d.title}"`);
    ok(res, null, 'Deliverable updated');
  })
);

/* POST /api/deliverables/:id/raw-link — client uploads the raw Drive link */
router.post(
  '/:id/raw-link',
  validate([
    param('id').isInt(),
    body('link').isURL().withMessage('A valid link is required'),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const { link } = req.body;
    if (!drive.isDriveLink(link)) {
      throw ApiError.badRequest('Please paste a valid Google Drive share link');
    }
    await query(
      "UPDATE deliverables SET raw_drive_link = ?, status = 'raw_uploaded' WHERE id = ?",
      [link, d.id]
    );
    audit(req, 'raw_upload', 'deliverable', d.id, `Raw link uploaded for "${d.title}"`);
    notifyAdmins('raw_uploaded', 'Raw content uploaded',
      `${d.company_name} uploaded raw content for "${d.title}".`, `#/deliverables/${d.id}`);
    ok(res, null, 'Raw link saved — status moved to Raw Uploaded');
  })
);

/* POST /api/deliverables/:id/poster — poster designer submits the finished design.
 * Scoped to the assignee (or an admin). Stores the design link and marks it
 * caption_ready so an admin can send it to the client. */
router.post(
  '/:id/poster',
  validate([
    param('id').isInt(),
    body('link').isURL().withMessage('A valid design link is required'),
    body('note').optional({ values: 'falsy' }).isLength({ max: 2000 }),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    if (req.user.role === 'poster_designer' && d.assigned_to !== req.user.id) {
      throw ApiError.forbidden('This task is not assigned to you');
    }
    // Submitting (or resubmitting after a send-back) puts the poster into ADMIN
    // review and clears any previous change note.
    await query(
      "UPDATE deliverables SET edited_link = ?, status = 'caption_ready', reject_reason = NULL, approval_status = 'pending' WHERE id = ?",
      [req.body.link, d.id]
    );
    if (req.body.note) {
      await query(
        'INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)',
        [d.id, req.user.id, req.user.role, req.body.note]
      );
    }
    audit(req, 'poster_submit', 'deliverable', d.id, `Poster design submitted for "${d.title}"`);
    notifyAdmins('general', '🎨 Poster design ready',
      `${req.user.name} submitted the poster for "${d.title}".`, `#/tasks/${d.id}`);
    ok(res, null, 'Design submitted — the admin has been notified');
  })
);

/* POST /api/deliverables/:id/status — workflow transition */
router.post(
  '/:id/status',
  validate([
    param('id').isInt(),
    body('status').isIn(STATUS_LIST).withMessage('Invalid status'),
    body('reason').optional({ values: 'falsy' }).isLength({ max: 2000 }),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const { status, reason } = req.body;

    if (req.user.role === 'client' && !CLIENT_ALLOWED.includes(status)) {
      throw ApiError.forbidden('Clients can only upload raw, approve, or request changes');
    }
    if (REASON_REQUIRED.includes(status) && !reason) {
      throw ApiError.badRequest(`A reason is required when marking content as ${status.replace(/_/g, ' ')}`);
    }

    // GATE 1 (content approval): when a client approves while the item is in
    // content_review, that approves the CONTENT — the video hasn't been made
    // yet — so advance to waiting_for_raw, not the final "approved".
    const contentGate = status === 'approved' && d.status === 'content_review';
    const effectiveStatus = contentGate ? 'waiting_for_raw' : status;

    const updates = { status: effectiveStatus };
    if (reason) updates.reject_reason = reason;
    // Re-submitting for approval clears the previous change note.
    if (['content_review', 'review'].includes(effectiveStatus)) {
      updates.reject_reason = null;
      updates.approval_status = 'pending';
    }

    // Keep the derived flags in sync with the workflow status.
    if (contentGate) updates.approval_status = 'pending'; // final approval still to come
    else if (effectiveStatus === 'approved') updates.approval_status = 'approved';
    if (effectiveStatus === 'changes_requested') updates.approval_status = 'changes_requested';
    if (effectiveStatus === 'rejected') { updates.approval_status = 'rejected'; updates.posting_status = 'rejected'; }
    if (effectiveStatus === 'scheduled') updates.posting_status = 'scheduled';
    if (effectiveStatus === 'posted' || effectiveStatus === 'completed') {
      updates.posting_status = 'posted';
      if (!d.posted_at) updates.posted_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await query(`UPDATE deliverables SET ${sets} WHERE id = ?`, [
      ...Object.values(updates), d.id,
    ]);

    // Approval trail + notifications
    if (['approved', 'changes_requested', 'rejected'].includes(status)) {
      await query(
        'INSERT INTO approvals (deliverable_id, client_id, action, reason, acted_by) VALUES (?,?,?,?,?)',
        [d.id, d.client_id, status === 'approved' ? 'approved' : status, reason || null, req.user.id]
      );
    }
    if (reason) {
      await query(
        'INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)',
        [d.id, req.user.id, req.user.role, reason]
      );
    }

    const title = `"${d.title}" — ${effectiveStatus.replace(/_/g, ' ')}`;
    if (req.user.role === 'client') {
      // Tell admins what the client just did (content approved vs final approved vs changes).
      const clientMsg = contentGate
        ? `${d.company_name} approved the content — ready for the raw video.`
        : status === 'approved'
          ? `${d.company_name} approved the final video.`
          : reason || `${d.company_name} updated the status.`;
      notifyAdmins(
        status === 'approved' ? 'approval_needed' : 'changes_requested',
        title, clientMsg, `#/deliverables/${d.id}`
      );
    } else {
      if (status === 'content_review') {
        notifyClient(d.client_id, 'approval_needed', 'Content ready for your review',
          `"${d.title}" — please review the content and approve or request changes.`, `#/content/${d.id}`);
      } else if (status === 'review') {
        const kind = d.video_type === 'Poster' ? 'poster' : 'final video';
        const Kind = d.video_type === 'Poster' ? 'Poster' : 'Final video';
        notifyClient(d.client_id, 'approval_needed', `${Kind} ready for your review`,
          `"${d.title}" — please review the ${kind} and approve or request changes.`, `#/content/${d.id}`);
      } else if (['scheduled', 'posted', 'completed', 'rejected', 'resolved'].includes(status)) {
        notifyClient(d.client_id, 'general', title, reason || 'Status updated by the agency.', `#/content/${d.id}`);
      }
    }

    audit(req, `status:${effectiveStatus}`, 'deliverable', d.id, title, { reason });
    ok(res, null, contentGate
      ? 'Content approved — ready for the raw video'
      : `Status updated to ${effectiveStatus.replace(/_/g, ' ')}`);
  })
);

/* POST /api/deliverables/:id/comments — task discussion (admins + owning client) */
router.post(
  '/:id/comments',
  validate([
    param('id').isInt(),
    body('message').trim().isLength({ min: 1, max: 4000 }).withMessage('Comment cannot be empty'),
    body('mentions').optional().isArray({ max: 20 }),
    body('attachments').optional().isArray({ max: 10 }),
    body('attachments.*.url').optional().isURL().withMessage('Attachment must be a valid URL'),
    body('attachments.*.name').optional().isLength({ max: 190 }),
  ]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const mentions = (req.body.mentions || []).map((m) => String(m).slice(0, 150));
    const attachments = (req.body.attachments || [])
      .filter((a) => a && a.url)
      .map((a) => ({ name: String(a.name || 'Attachment').slice(0, 190), url: String(a.url) }));

    const r = await query(
      `INSERT INTO task_comments (deliverable_id, author_id, author_role, message, mentions, attachments)
       VALUES (?,?,?,?,?,?)`,
      [d.id, req.user.id, req.user.role, req.body.message.trim(),
        JSON.stringify(mentions), JSON.stringify(attachments)]
    );
    const comment = await queryOne(
      `SELECT tc.*, u.name AS author_name FROM task_comments tc
       LEFT JOIN users u ON u.id = tc.author_id WHERE tc.id = ?`, [r.insertId]
    );

    audit(req, 'comment', 'deliverable', d.id, `Commented on "${d.title}"`);
    const preview = req.body.message.trim().slice(0, 120);
    if (req.user.role === 'client') {
      notifyAdmins('general', `💬 ${d.company_name} commented`, `"${d.title}": ${preview}`, `#/tasks/${d.id}?tab=comments`);
    } else {
      notifyClient(d.client_id, 'general', '💬 New comment from your agency', `"${d.title}": ${preview}`, `#/content/${d.id}`);
    }
    ok(res, comment, 'Comment added', 201);
  })
);

/* POST /api/deliverables/:id/versions/:versionId/restore — roll a field back.
 * The restore itself is recorded as a new version row: history is append-only. */
router.post(
  '/:id/versions/:versionId/restore',
  requireAdmin,
  validate([param('id').isInt(), param('versionId').isInt()]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    const v = await queryOne(
      'SELECT * FROM content_versions WHERE id = ? AND deliverable_id = ?',
      [Number(req.params.versionId), d.id]
    );
    if (!v) throw ApiError.notFound('Version not found');
    if (!VERSIONED_FIELDS.includes(v.field)) throw ApiError.badRequest('This field cannot be restored');

    const restoredValue = v.old_value; // the value BEFORE that change
    await recordVersions(req, d, { [v.field]: restoredValue ?? '' });
    await query(`UPDATE deliverables SET ${v.field} = ? WHERE id = ?`, [restoredValue, d.id]);

    audit(req, 'version_restore', 'deliverable', d.id,
      `Restored ${v.field} of "${d.title}" to version #${v.id}`);
    ok(res, { field: v.field, value: restoredValue }, `${v.field.replace(/_/g, ' ')} restored`);
  })
);

/* DELETE /api/deliverables/:id (admin) */
router.delete(
  '/:id',
  requireAdmin,
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const d = await loadScoped(req, Number(req.params.id));
    await query('DELETE FROM deliverables WHERE id = ?', [d.id]);
    audit(req, 'delete', 'deliverable', d.id, `Deleted "${d.title}"`);
    ok(res, null, 'Deliverable deleted');
  })
);

module.exports = router;
