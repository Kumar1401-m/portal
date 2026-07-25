/**
 * Task Details Workspace — the full-page collaboration surface for one
 * content item. Replaces every task popup.
 *
 * Tabs: Overview · Content · Media · AI Assistant · Approvals · Promotion ·
 *       Payments · Analytics · Activity · Comments · History
 *
 * All tab panes stay mounted (hidden-toggled) so switching tabs never loses
 * unsaved edits. Dirty fields are tracked against a snapshot; Save Draft
 * patches only what changed. AI + comment actions update in place so drafts
 * survive them too.
 */
'use strict';

const TW = {
  d: null,            // task payload
  orig: {},           // field name -> original value snapshot
  team: [],           // admin users for editor/mentions
  attachments: [],    // pending comment attachments
  mentioned: new Set(),
  activeTab: 'overview',
};

const TW_FIELDS = [
  'title', 'description', 'platform', 'video_type', 'promotion_type', 'content_category',
  'language', 'target_audience', 'video_duration', 'campaign', 'content_hook', 'caption',
  'ai_prompt', 'custom_instructions', 'writer_notes', 'videographer_notes', 'editor_notes',
  'client_notes', 'raw_drive_link', 'edited_link', 'thumbnail_url', 'subtitle_link',
  'due_date', 'priority', 'assigned_to', 'scheduled_at', 'posted_by',
  'instagram_status', 'facebook_status', 'youtube_status',
  'metric_views', 'metric_reach', 'metric_likes', 'metric_comments', 'metric_shares', 'metric_saves',
];
const TW_METRICS = ['metric_views', 'metric_reach', 'metric_likes', 'metric_comments', 'metric_shares', 'metric_saves'];

const TABS = [
  ['overview', 'Overview'], ['content', 'Content'], ['media', 'Media'], ['ai', 'AI Assistant'],
  ['approvals', 'Approvals'], ['promotion', 'Promotion'], ['payments', 'Payments'],
  ['analytics', 'Analytics'], ['activity', 'Activity'], ['comments', 'Comments'], ['history', 'History'],
];

/* ---------------- helpers ---------------- */

const twVal = (name) => {
  const el = page.querySelector(`[name="${name}"]`);
  return el ? el.value : undefined;
};
const twNorm = (v) => (v === null || v === undefined ? '' : String(v));

function twSnapshot() {
  TW.orig = {};
  TW_FIELDS.forEach((f) => {
    const v = twVal(f);
    if (v !== undefined) TW.orig[f] = v;
  });
}

function twDirtyFields() {
  return Object.keys(TW.orig).filter((f) => twVal(f) !== TW.orig[f]);
}

let twLastDirtyCount = -1;
function twRefreshDirtyUI() {
  const dirty = twDirtyFields();
  Object.keys(TW.orig).forEach((f) => {
    const field = page.querySelector(`.field[data-f="${f}"]`);
    if (field) field.classList.toggle('dirty', dirty.includes(f));
  });
  if (dirty.length !== twLastDirtyCount) {
    twLastDirtyCount = dirty.length;
    const save = $('#twSave');
    if (save) {
      save.innerHTML = dirty.length
        ? `<i data-lucide="save"></i> Save Draft (${dirty.length})`
        : '<i data-lucide="save"></i> Save Draft';
      icons();
    }
  }
  ERP.guard = dirty.length
    ? () => `You have ${dirty.length} unsaved change(s) on this task. Leave without saving?`
    : null;
}

/* One delegated listener for the whole app lifetime (renders swap the DOM). */
page.addEventListener('input', (e) => {
  if (TW.d && e.target.name && TW_FIELDS.includes(e.target.name) && page.querySelector('.ws-head')) {
    twRefreshDirtyUI();
  }
});

/** Re-render the workspace, staying on the current tab. */
async function twReload() {
  ERP.guard = null;
  await ERP.routes['task-full'](TW.d.id, new URLSearchParams(`tab=${TW.activeTab}`));
  icons();
}

/** PATCH only dirty fields. Returns true if the task is clean afterwards. */
async function twSaveDraft(silent = false) {
  const dirty = twDirtyFields();
  if (!dirty.length) { if (!silent) toastOk('Nothing to save'); return true; }
  const body = {};
  dirty.forEach((f) => {
    let v = twVal(f);
    if (TW_METRICS.includes(f)) v = String(Number(v || 0)); // NOT NULL columns — never send ''
    body[f] = v;
  });
  if (!Object.keys(body).length) return true;
  try {
    await Api.patch(`/api/deliverables/${TW.d.id}`, body);
    if (!silent) toastOk('Draft saved');
    Object.keys(body).forEach((f) => { TW.orig[f] = twNorm(twVal(f)); });
    if (body.title) { const h = $('#twTitleView'); if (h) h.textContent = body.title; }
    twRefreshDirtyUI();
    return true;
  } catch (ex) { toastErr(errText(ex)); return false; }
}

async function twSetStatus(status, reason) {
  if (REASON_REQUIRED.includes(status) && !reason) {
    reason = window.prompt(`A reason is required for "${statusLabel(status)}":`, '');
    if (!reason) return;
  }
  const saved = await twSaveDraft(true);
  if (!saved) return;
  try {
    const res = await Api.post(`/api/deliverables/${TW.d.id}/status`, { status, reason: reason || undefined });
    toastOk(res.message);
    await twReload();
  } catch (ex) { toastErr(ex.message); }
}

/** Progress model for the right rail. */
function twProgress(d) {
  let flowIdx = STATUS_FLOW.indexOf(d.status);
  if (d.status === 'changes_requested') flowIdx = STATUS_FLOW.indexOf('review');
  if (d.status === 'resolved') flowIdx = STATUS_FLOW.indexOf('review');
  if (flowIdx < 0) flowIdx = 0;
  const overall = ['rejected', 'cancelled'].includes(d.status) ? 0
    : Math.round((flowIdx / (STATUS_FLOW.length - 1)) * 100);

  const contentBits = ['raw_drive_link', 'edited_link', 'caption', 'thumbnail_url']
    .filter((f) => d[f] && String(d[f]).trim()).length;
  const content = Math.round((contentBits / 4) * 100);

  const approvalMap = { pending: d.status === 'review' ? 50 : 10, changes_requested: 35, approved: 100, rejected: 0 };
  const approval = approvalMap[d.approval_status] ?? 0;
  return { overall, content, approval };
}

const twBar = (lbl, pct, color) => `
  <div style="margin-bottom:11px">
    <div style="display:flex;justify-content:space-between;font-size:.74rem;margin-bottom:4px">
      <span style="color:var(--ink-2);font-weight:600">${lbl}</span><span style="font-weight:700">${pct}%</span></div>
    <div class="progress"><div style="width:${pct}%;${color ? `background:${color}` : ''}"></div></div>
  </div>`;

const linkBtns = (url) => url ? `
  <a class="btn btn-outline btn-sm" href="${esc(url)}" target="_blank" rel="noopener"><i data-lucide="download"></i> Open / Download</a>
  <button class="btn btn-ghost btn-sm" data-copy-link="${esc(url)}"><i data-lucide="copy"></i> Copy link</button>` : '';

/* ---------------- NEW TASK (full page) ---------------- */

ERP.register('task-new', async function renderTaskNew(params) {
  const clients = await getClients();
  if (!clients.length) {
    page.innerHTML = '<div class="card"><div class="card-body empty">Add a client first, then create tasks. <a class="link-btn" href="#/clients/new">Add client →</a></div></div>';
    return;
  }
  const preClient = Number(params.get('client_id')) || '';

  page.innerHTML = `
    <div class="page-head">
      <div>
        <a class="link-btn" href="#/content">← Back</a>
        <h1 style="margin-top:4px">New Task</h1>
        <div class="sub">Plan a new content item — you'll land in its workspace right after</div>
      </div>
      <div class="head-actions">
        <a class="btn btn-outline" href="#/content">Cancel</a>
        <button class="btn btn-primary" id="createTask"><i data-lucide="plus"></i> Create Task</button>
      </div>
    </div>
    <form id="newTaskForm" style="max-width:640px">
      <div class="card"><div class="card-body">
        ${F.select('client_id', 'Client *', clients.map((c) => `<option value="${c.id}" ${preClient === c.id ? 'selected' : ''}>${esc(c.company_name)}</option>`).join(''))}
        ${F.input('title', 'Title *', '', { extra: 'required', ph: 'e.g. Diwali offer reel' })}
        <div class="form-row">
          ${F.select('platform', 'Platform', '<option value="instagram_reel">Instagram Reel</option>')}
          ${F.select('video_type', 'Type', selectOptions(['Reel', 'Poster'], 'Reel'))}
        </div>
        ${F.input('due_date', 'Due date', '', { type: 'date' })}
        ${F.area('content_hook', 'Content / Brief', '', { rows: 6, ph: 'What the video / poster is about — script, key points, offer…' })}
      </div></div>
    </form>`;

  $('#createTask').onclick = async () => {
    const fd = new FormData($('#newTaskForm'));
    const title = String(fd.get('title') || '').trim();
    if (!title) return toastErr('Title is required');
    const basics = { client_id: fd.get('client_id'), title, platform: fd.get('platform') || 'instagram_reel' };
    const due = String(fd.get('due_date') || '').trim();
    if (due) basics.due_date = due;
    const brief = String(fd.get('content_hook') || '').trim();
    try {
      const res = await Api.post('/api/deliverables', basics);
      const id = res.data.ids[0];
      const patch = {};
      const vt = fd.get('video_type'); if (vt) patch.video_type = vt;
      if (brief) { patch.content_hook = brief; patch.description = brief; }
      if (Object.keys(patch).length) await Api.patch(`/api/deliverables/${id}`, patch).catch(() => {});
      toastOk('Task created');
      nav(`/tasks/${id}`);
    } catch (ex) { toastErr(errText(ex)); }
  };
  icons();
});

/* ---------------- TASK WORKSPACE ---------------- */

ERP.register('task-full', async function renderTask(id, params) {
  page.innerHTML = '<div class="empty">Loading task…</div>';
  const [r, teamRes] = await Promise.all([
    Api.get(`/api/deliverables/${id}`),
    Api.get('/api/users?limit=100').catch(() => ({ data: [] })),
  ]);
  const d = r.data;
  TW.d = d;
  TW.team = teamRes.data.filter((u2) => u2.is_active);
  TW.attachments = [];
  TW.mentioned = new Set();
  TW.activeTab = params.get('tab') && TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const c = d.client || {};
  const ai = d.ai_analysis;
  const prog = twProgress(d);

  const userOptions = (sel) => ['<option value="">—</option>']
    .concat(TW.team.map((u2) => `<option value="${u2.id}" ${Number(sel) === u2.id ? 'selected' : ''}>${esc(u2.name)}</option>`)).join('');

  /* ---------- header ---------- */
  const logo = c.company_logo_url
    ? `<img src="${esc(c.company_logo_url)}" alt="">`
    : esc((c.company_name || 'C')[0].toUpperCase());

  page.innerHTML = `
    <div class="ws-head">
      <div class="ws-head-top">
        <a class="iconbtn" href="#/content" title="Back to content" style="flex:0 0 36px"><i data-lucide="arrow-left"></i></a>
        <div class="ws-client">
          <div class="ws-logo">${logo}</div>
          <div class="ws-title">
            <h1 id="twTitleView">${esc(d.title)}</h1>
            <div class="ws-meta">
              <strong>${esc(c.company_name || d.company_name || '')}</strong>
              <span class="sep">·</span><span>${taskCode(d.id)}</span>
              <span class="sep">·</span><span>${esc(d.video_type || d.content_type || 'Content')}</span>
              <span class="sep">·</span><span class="badge b-primary">${label(d.platform)}</span>
              ${statusBadge(d.status)}
              <span class="sep">·</span><span>Due ${fmtDate(d.due_date)}</span>
              ${badge(d.priority)}
            </div>
          </div>
        </div>
        <div class="ws-actions">
          <button class="btn btn-outline" id="twSave"><i data-lucide="save"></i> Save Draft</button>
          <button class="btn btn-soft" id="twSendApproval"><i data-lucide="send"></i> Send for Approval</button>
          <button class="btn btn-success" id="twComplete"><i data-lucide="check-check"></i> Mark Completed</button>
          <button class="btn btn-ghost" id="twCancel">Cancel</button>
          <button class="btn btn-ghost btn-sm" id="twDelete" title="Delete task" style="color:var(--red)"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="tabs" id="twTabs">
        ${TABS.map(([k, lbl]) => `<button class="tab ${TW.activeTab === k ? 'active' : ''}" data-tw-tab="${k}">${lbl}${k === 'comments' && d.comments.length ? ` (${d.comments.length})` : ''}</button>`).join('')}
      </div>
    </div>

    <div class="ws-body">
      <div class="ws-main">
        ${paneOverview(d, c)}
        ${paneContent(d)}
        ${paneMedia(d)}
        ${paneAI(d, ai)}
        ${paneApprovals(d)}
        ${panePromotion(d, userOptions)}
        ${panePayments(c)}
        ${paneAnalytics(d, ai)}
        ${paneActivity()}
        ${paneComments(d)}
        ${paneHistory(d)}
      </div>

      <aside class="ws-rail">
        <div class="card"><div class="card-head"><h3>Quick Summary</h3></div><div class="card-body">
          <div class="kv"><span class="k">Status</span><span class="v">${statusBadge(d.status)}</span></div>
          <div class="kv"><span class="k">Approval</span><span class="v">${badge(d.approval_status)}</span></div>
          <div class="kv"><span class="k">Created by</span><span class="v">${esc(d.created_by_name || '—')}</span></div>
          <div class="kv"><span class="k">Created</span><span class="v">${fmtDate(d.created_at)}</span></div>
          <div class="kv"><span class="k">Updated</span><span class="v">${fmtDateTime(d.updated_at)}</span></div>
          <div class="divider" style="margin:10px 0"></div>
          <div class="field" data-f="assigned_to"><label>Editor / assignee</label>
            <select name="assigned_to">${userOptions(d.assigned_to)}</select></div>
          <div class="form-row">
            <div class="field" data-f="due_date"><label>Due date</label>
              <input type="date" name="due_date" value="${(d.due_date || '').slice(0, 10)}"></div>
            <div class="field" data-f="priority"><label>Priority</label>
              <select name="priority">${selectOptions(['low', 'medium', 'high', 'urgent'], d.priority)}</select></div>
          </div>
        </div></div>
        <div class="card"><div class="card-head"><h3>Progress</h3></div><div class="card-body">
          ${twBar('Overall', prog.overall)}
          ${twBar('Content', prog.content, 'var(--blue)')}
          ${twBar('Approval', prog.approval, 'var(--green)')}
          ${d.ai_score ? `<div class="kv" style="border:none;padding-top:4px"><span class="k">AI Quality Score</span>
            <span class="v" style="color:${scoreColor(d.ai_score)};font-weight:800">${d.ai_score}/100</span></div>` : ''}
        </div></div>
      </aside>
    </div>`;

  /* ---------- wiring ---------- */
  twSnapshot();
  twLastDirtyCount = -1;
  twRefreshDirtyUI();

  // Tab switching — panes stay mounted, so unsaved input survives.
  const showTab = (key) => {
    TW.activeTab = key;
    $$('#twTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.twTab === key));
    $$('.tab-pane', page).forEach((p) => { p.hidden = p.dataset.pane !== key; });
    if (key === 'activity') twLoadActivity();
  };
  $$('#twTabs .tab').forEach((b) => (b.onclick = () => showTab(b.dataset.twTab)));
  showTab(TW.activeTab);
  $$('[data-goto-tab]', page).forEach((b) => (b.onclick = () => showTab(b.dataset.gotoTab)));

  // Header actions
  $('#twSave').onclick = () => twSaveDraft();
  $('#twSendApproval').onclick = () => {
    const link = (twVal('edited_link') || TW.d.edited_link || '').trim();
    if (!link) {
      toastErr('Upload the edited video / drive link before sending for approval');
      showTab('media');
      page.querySelector('[name="edited_link"]')?.focus();
      return;
    }
    twSetStatus('review');
  };
  $('#twComplete').onclick = () => twSetStatus('completed');
  $('#twCancel').onclick = () => nav('/content');
  $('#twDelete').onclick = () => confirmModal('Delete task', `Delete "${TW.d.title}" permanently? All versions, comments and history go with it.`, async () => {
    await Api.del(`/api/deliverables/${TW.d.id}`);
    ERP.guard = null;
    toastOk('Task deleted');
    nav('/content');
  });

  // Workflow status control
  $('#twApplyStatus').onclick = () => twSetStatus($('#twStatusSel').value, $('#twStatusReason').value.trim());
  $$('[data-quick-status]').forEach((b) => (b.onclick = () => twSetStatus(b.dataset.quickStatus)));

  // Copy-link buttons (media)
  $$('[data-copy-link]').forEach((b) => (b.onclick = () =>
    navigator.clipboard.writeText(b.dataset.copyLink).then(() => toastOk('Link copied'))));
  $('#twCopyCaption')?.addEventListener('click', () => {
    navigator.clipboard.writeText(twVal('caption') || '').then(() => toastOk('Caption copied'));
  });

  wireAIPane();
  wirePayments();
  wireComments();
  wireHistory();
  icons();
});

/* ================= PANES ================= */

function paneOverview(d, c) {
  const doneIdx = STATUS_FLOW.indexOf(['changes_requested', 'resolved'].includes(d.status) ? 'review' : d.status);
  return `
  <section class="tab-pane" data-pane="overview" hidden>
    <div class="card"><div class="card-head"><h3>Workflow</h3></div><div class="card-body">
      <div class="stepper" style="margin-bottom:14px">
        ${STATUS_FLOW.map((s, i) => `<span class="step ${i < doneIdx ? 'done' : ''} ${s === d.status || (i === doneIdx && ['changes_requested', 'resolved'].includes(d.status)) ? 'current' : ''}">${i < doneIdx ? '✓ ' : ''}${statusLabel(s)}</span>`).join('')}
        ${['changes_requested', 'resolved', 'rejected', 'cancelled'].includes(d.status) ? `<span class="step blocked">● ${statusLabel(d.status)}</span>` : ''}
      </div>
      ${d.reject_reason ? `<div class="feedback-item" style="background:var(--red-bg);color:var(--red)"><strong>Last reason:</strong> ${esc(d.reject_reason)}</div>` : ''}
      <div class="form-row" style="align-items:end">
        <div class="field" style="margin:0"><label>Move to status</label>
          <select id="twStatusSel">${STATUSES.map((s) => `<option value="${s}" ${d.status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}</select></div>
        <div class="field" style="margin:0"><label>Reason <span style="color:var(--ink-3)">(required for rejected / changes / cancelled)</span></label>
          <input id="twStatusReason" placeholder="Why?"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-primary btn-sm" id="twApplyStatus">Update Status</button>
        ${d.status === 'changes_requested' ? '<button class="btn btn-outline btn-sm" data-quick-status="resolved">Mark changes resolved</button>' : ''}
        ${d.status === 'approved' ? '<button class="btn btn-outline btn-sm" data-quick-status="scheduled">Mark scheduled</button>' : ''}
        ${d.status === 'scheduled' ? '<button class="btn btn-outline btn-sm" data-quick-status="posted">Mark posted</button>' : ''}
      </div>
    </div></div>

    <div class="card"><div class="card-head"><h3>Content Information</h3></div><div class="card-body">
      ${F.input('title', 'Title *', d.title, { extra: 'required' })}
      <div class="form-row-3">
        ${F.select('video_type', 'Video type', selectOptions(VIDEO_TYPES, d.video_type, '—'))}
        ${F.select('promotion_type', 'Promotion type', selectOptions(PROMOTION_TYPES, d.promotion_type, '—'))}
        ${F.select('platform', 'Platform', platformOptions(d.platform))}
      </div>
      <div class="form-row-3">
        ${F.input('campaign', 'Campaign', d.campaign)}
        ${F.select('content_category', 'Content category', selectOptions(CONTENT_CATEGORIES, d.content_category, '—'))}
        ${F.input('language', 'Language', d.language, { ph: 'e.g. Telugu, English' })}
      </div>
      <div class="form-row">
        ${F.input('target_audience', 'Target audience', d.target_audience)}
        ${F.input('video_duration', 'Video duration', d.video_duration, { ph: 'e.g. 30s' })}
      </div>
      ${d.thumbnail_url ? `<div class="field"><label>Thumbnail</label><img class="thumb-preview" src="${esc(d.thumbnail_url)}" alt="thumbnail"></div>` : ''}
    </div></div>

    <div class="card"><div class="card-head"><h3>Client Information</h3>
      <a class="link-btn" href="#/clients/${d.client_id}">Open client →</a></div>
    <div class="card-body">
      <div class="grid grid-2" style="gap:0 26px">
        <div>
          <div class="kv"><span class="k">Company</span><span class="v">${esc(c.company_name || '—')}</span></div>
          <div class="kv"><span class="k">Contact person</span><span class="v">${esc(c.contact_person || '—')}</span></div>
          <div class="kv"><span class="k">Phone</span><span class="v">${esc(c.phone || '—')}</span></div>
          <div class="kv"><span class="k">Email</span><span class="v">${esc(c.email || '—')}</span></div>
          <div class="kv"><span class="k">Business category</span><span class="v">${esc(c.business_type || '—')}</span></div>
        </div>
        <div>
          <div class="kv"><span class="k">Website</span><span class="v">${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</span></div>
          <div class="kv"><span class="k">Instagram</span><span class="v">${c.instagram_link ? `<a href="${esc(c.instagram_link)}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</span></div>
          <div class="kv"><span class="k">Facebook</span><span class="v">${c.facebook_link ? `<a href="${esc(c.facebook_link)}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</span></div>
          <div class="kv"><span class="k">YouTube</span><span class="v">${c.youtube_link ? `<a href="${esc(c.youtube_link)}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</span></div>
          <div class="kv"><span class="k">Package</span><span class="v">${esc(c.monthly_package || '—')} · ${fmtMoney(c.package_amount)}</span></div>
        </div>
      </div>
    </div></div>
  </section>`;
}

function paneContent(d) {
  return `
  <section class="tab-pane" data-pane="content" hidden>
    <div class="card"><div class="card-head"><h3>Video Content</h3>
      <button class="btn btn-ghost btn-sm" id="twCopyCaption"><i data-lucide="copy"></i> Copy caption</button></div>
    <div class="card-body">
      ${F.area('content_hook', 'Content hook', d.content_hook, { rows: 2, ph: 'First 3 seconds — what stops the scroll?' })}
      ${F.area('caption', 'Caption', d.caption, { rows: 6 })}
      ${F.area('description', 'Description / brief', d.description, { rows: 4 })}
      ${F.area('ai_prompt', 'AI prompt used', d.ai_prompt, { rows: 2, ph: 'Prompt given to AI tools for this content' })}
      ${F.area('custom_instructions', 'Custom instructions', d.custom_instructions, { rows: 3 })}
    </div></div>
    <div class="card"><div class="card-head"><h3>Team Notes</h3></div><div class="card-body">
      <div class="form-row">
        ${F.area('writer_notes', '✍️ Content writer notes', d.writer_notes, { rows: 4 })}
        ${F.area('videographer_notes', '🎥 Videographer notes', d.videographer_notes, { rows: 4 })}
      </div>
      <div class="form-row">
        ${F.area('editor_notes', '🎬 Editor notes', d.editor_notes, { rows: 4 })}
        ${F.area('client_notes', '🏷 Client notes', d.client_notes, { rows: 4 })}
      </div>
    </div></div>
  </section>`;
}

function paneMedia(d) {
  const mediaItem = (icon, title, name, val, previewHtml = '') => `
    <div class="media-item">
      <div class="media-title"><i data-lucide="${icon}"></i> ${title}</div>
      ${F.input(name, 'File link (Google Drive or direct URL)', val, { type: 'url', ph: 'https://drive.google.com/…' })}
      <div class="media-actions">${linkBtns(val)}</div>
      ${previewHtml}
    </div>`;

  const drivePreview = (preview, direct) => {
    if (preview) return `<div class="preview-frame" style="margin-top:10px"><iframe src="${esc(preview)}" allow="autoplay" loading="lazy"></iframe></div>`;
    if (direct && /\.(mp4|webm|mov)(\?|$)/i.test(direct)) return `<div class="preview-frame" style="margin-top:10px"><video src="${esc(direct)}" controls preload="none"></video></div>`;
    return '';
  };

  return `
  <section class="tab-pane" data-pane="media" hidden>
    <div class="card"><div class="card-head"><h3>Media Files</h3>
      <span class="hint" style="margin:0">Paste a link to upload/replace — Drive links get an inline preview player</span></div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
      ${mediaItem('film', 'Raw Video', 'raw_drive_link', d.raw_drive_link, drivePreview(d.raw_preview, d.raw_drive_link))}
      ${mediaItem('clapperboard', 'Edited Video', 'edited_link', d.edited_link, drivePreview(d.edited_preview, d.edited_link))}
      ${mediaItem('image', 'Thumbnail', 'thumbnail_url', d.thumbnail_url,
        d.thumbnail_url ? `<img class="thumb-preview" style="margin-top:10px" src="${esc(d.thumbnail_url)}" alt="thumbnail">` : '')}
      ${mediaItem('captions', 'Subtitle File (.srt / .vtt)', 'subtitle_link', d.subtitle_link)}
    </div></div>
  </section>`;
}

function paneAI(d, ai) {
  const rawJson = (() => { try { return typeof ai?.raw_json === 'string' ? JSON.parse(ai.raw_json) : (ai?.raw_json || {}); } catch { return {}; } })();
  const detectedLang = rawJson?.analysis?.detected_language || '—';
  return `
  <section class="tab-pane" data-pane="ai" hidden>
    <div class="card"><div class="card-head"><h3>AI Assistant</h3>
      <span class="badge b-violet" id="twAiProvider">${ai ? esc(ai.provider || '') : 'not analysed yet'}</span></div>
    <div class="card-body">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        ${d.ai_score ? `
        <div class="score-ring" style="background:${scoreColor(d.ai_score)}1f;color:${scoreColor(d.ai_score)}">${d.ai_score}</div>
        <div><strong>AI Quality Score</strong><div class="t-sub">out of 100</div></div>` : '<div class="t-sub">Run a video analysis or quality check to get a score.</div>'}
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-ai="analyze"><i data-lucide="sparkles"></i> Video Analysis</button>
          <button class="btn btn-outline btn-sm" data-ai="quality"><i data-lucide="scan-search"></i> Quality Check</button>
        </div>
      </div>
      <div class="ai-grid">
        <button class="ai-btn" data-ai="caption"><i data-lucide="pen-line"></i> Generate Caption</button>
        <button class="ai-btn" data-ai="caption"><i data-lucide="rotate-ccw"></i> Regenerate Caption</button>
        <button class="ai-btn" data-ai-gen="hooks"><i data-lucide="anchor"></i> Generate Hooks</button>
        <button class="ai-btn" data-ai-gen="hashtags"><i data-lucide="hash"></i> Generate Hashtags</button>
        <button class="ai-btn" data-ai-gen="seo_keywords"><i data-lucide="search-check"></i> SEO Keywords</button>
        <button class="ai-btn" data-ai-gen="thumbnail_title"><i data-lucide="image"></i> Thumbnail Title</button>
        <button class="ai-btn" data-ai-gen="cta"><i data-lucide="megaphone"></i> Generate CTA</button>
        <button class="ai-btn" data-ai-gen="instagram_caption"><i data-lucide="instagram"></i> Instagram Caption</button>
        <button class="ai-btn" data-ai-gen="facebook_caption"><i data-lucide="facebook"></i> Facebook Caption</button>
        <button class="ai-btn" data-ai-gen="youtube_description"><i data-lucide="youtube"></i> YouTube Description</button>
        <button class="ai-btn" data-ai-gen="alt_text"><i data-lucide="accessibility"></i> Generate Alt Text</button>
        <button class="ai-btn" data-ai-gen="summary"><i data-lucide="text"></i> Generate Summary</button>
      </div>
      <div class="divider"></div>
      <div class="grid grid-3" style="gap:12px;margin-bottom:4px">
        <div><div class="t-sub">Detected language</div><strong id="twDetectedLang">${esc(detectedLang)}</strong></div>
        <div><div class="t-sub">Suggested platform</div><strong>${esc(ai?.suggested_platform || '—')}</strong></div>
        <div><div class="t-sub">Best posting time</div><strong>${esc(ai?.best_time || '—')}</strong></div>
      </div>
    </div></div>

    <div class="card"><div class="card-head"><h3>AI Output</h3></div>
      <div class="card-body" id="twAiPanel">${ai ? aiPanelHtml(ai) : '<div class="t-sub">Run "Video Analysis" to generate the caption, hooks, hashtags, SEO keywords, transcript and quality score in one go — or use the individual generators above.</div>'}</div>
    </div>

    <div class="card"><div class="card-head"><h3>Brand · Logo · Footer Detection</h3></div><div class="card-body">
      <div class="t-sub" style="margin-bottom:10px">Runs AI client detection against the thumbnail / creative to verify the right branding (logo, watermark, footer) is present.</div>
      <button class="btn btn-outline btn-sm" id="twDetectBrand"><i data-lucide="scan-face"></i> Detect Branding</button>
      <div id="twDetectOut" style="margin-top:10px"></div>
    </div></div>
  </section>`;
}

function aiPanelHtml(ai) {
  const parse = (v, fb = []) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || fb); } catch { return fb; } };
  const hooks = parse(ai.hooks);
  const seo = parse(ai.seo_keywords);
  const quality = parse(ai.quality_json, {});
  const sec = (title, content) => content
    ? `<details style="margin-bottom:8px" open><summary style="cursor:pointer;font-weight:600;font-size:.86rem;padding:4px 0">${title}</summary>
       <div style="padding:6px 0">${content}</div></details>` : '';
  return `
    ${ai.summary ? `<p style="font-size:.86rem;color:var(--ink-2);margin-bottom:10px">${esc(ai.summary)}</p>` : ''}
    ${sec('📝 Suggested caption', ai.caption ? `<div class="copy-box">${esc(ai.caption)}</div>` : '')}
    ${sec('🪝 Hooks', hooks.length ? hooks.map((h) => `<div class="copy-box" style="margin-bottom:5px">${esc(h)}</div>`).join('') : '')}
    ${sec('#️⃣ Hashtags', ai.hashtags ? `<div class="copy-box">${esc(ai.hashtags)}</div>` : '')}
    ${sec('🔍 SEO keywords', seo.length ? `<div class="chip-row">${seo.map((k) => `<span class="badge b-gray">${esc(k)}</span>`).join('')}</div>` : '')}
    ${sec('🎯 CTA', ai.cta ? `<div class="copy-box">${esc(ai.cta)}</div>` : '')}
    ${sec('🖼 Thumbnail title', ai.thumbnail_title ? `<div class="copy-box">${esc(ai.thumbnail_title)}</div>` : '')}
    ${sec('📄 YouTube / reel description', ai.reel_description ? `<div class="copy-box">${esc(ai.reel_description)}</div>` : '')}
    ${sec('💬 Facebook / social copy', ai.social_copy ? `<div class="copy-box">${esc(ai.social_copy)}</div>` : '')}
    ${sec('♿ Alt text', ai.alt_text ? `<div class="copy-box">${esc(ai.alt_text)}</div>` : '')}
    ${sec('🎬 Speech transcript', ai.transcript ? `<div class="copy-box" style="max-height:180px;overflow:auto">${esc(ai.transcript)}</div>` : '')}
    ${Object.keys(quality).length ? sec('🧪 Quality checks', Object.entries(quality).map(([k, v]) => `
      <div class="kv"><span class="k">${label(k)}</span>
        <span class="v" style="color:${scoreColor(v.score)}">${v.score}/100</span></div>
      <div class="t-sub" style="margin-bottom:6px">${esc(v.note || '')}</div>`).join('')) : ''}`;
}

function paneApprovals(d) {
  const changeRequests = d.feedback.filter((f) => !f.is_resolved);
  const lastApproval = d.approvals[0];
  return `
  <section class="tab-pane" data-pane="approvals" hidden>
    <div class="card"><div class="card-head"><h3>Approval Status</h3></div><div class="card-body">
      <div class="grid grid-3" style="gap:12px;margin-bottom:14px">
        <div><div class="t-sub">Approval status</div>${badge(d.approval_status)}</div>
        <div><div class="t-sub">Approval date</div><strong>${lastApproval && lastApproval.action === 'approved' ? fmtDateTime(lastApproval.created_at) : '—'}</strong></div>
        <div><div class="t-sub">Acted by</div><strong>${esc(lastApproval?.actor_name || '—')}</strong></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${d.status !== 'review' ? '<button class="btn btn-soft btn-sm" data-quick-status="review"><i data-lucide="send"></i> Send for client review</button>' : ''}
        <button class="btn btn-success btn-sm" data-quick-status="approved"><i data-lucide="check"></i> Approve</button>
        <button class="btn btn-outline btn-sm" data-quick-status="changes_requested"><i data-lucide="pencil-ruler"></i> Request changes</button>
        ${d.status === 'changes_requested' ? '<button class="btn btn-outline btn-sm" data-quick-status="resolved">Mark resolved</button>' : ''}
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" data-quick-status="rejected">Reject</button>
      </div>
    </div></div>

    <div class="card"><div class="card-head"><h3>Client Feedback & Suggested Changes</h3></div><div class="card-body">
      ${d.feedback.length ? d.feedback.map((f) => `
        <div class="feedback-item" style="${f.is_resolved ? 'opacity:.65' : ''}">
          ${esc(f.message)}
          <div class="f-meta">${esc(f.author_name || 'Unknown')} (${label(f.author_role || '')}) · ${fmtDateTime(f.created_at)} ${f.is_resolved ? '· ✓ resolved' : ''}</div>
        </div>`).join('') : '<div class="empty">No feedback yet</div>'}
      ${changeRequests.length ? `<div class="hint">Open change requests: ${changeRequests.length}. Use "Mark resolved" once addressed — the client will be notified for re-review.</div>` : ''}
    </div></div>

    <div class="card"><div class="card-head"><h3>Internal Remarks & Resolved Notes</h3>
      <button class="btn btn-ghost btn-sm" data-goto-tab="content"><i data-lucide="pen-line"></i> Edit in Content tab</button></div>
    <div class="card-body">
      <div class="kv" style="align-items:start"><span class="k">Internal remarks (editor)</span>
        <span class="v" style="font-weight:400;white-space:pre-wrap">${esc(d.editor_notes || '—')}</span></div>
      <div class="kv" style="align-items:start"><span class="k">Resolved notes (client)</span>
        <span class="v" style="font-weight:400;white-space:pre-wrap">${esc(d.client_notes || '—')}</span></div>
      <div class="hint">Both are edited under Content → Team Notes and versioned in History.</div>
    </div></div>

    <div class="card"><div class="card-head"><h3>Approval Timeline</h3></div><div class="card-body">
      ${d.approvals.length ? `<div class="timeline">${d.approvals.map((a) => `
        <div class="tl-item">
          <span class="tl-dot ${a.action === 'approved' ? 'good' : a.action === 'rejected' ? 'bad' : ''}"></span>
          <div class="tl-title">${label(a.action)} by ${esc(a.actor_name || '—')}</div>
          ${a.reason ? `<div class="tl-body">${esc(a.reason)}</div>` : ''}
          <div class="tl-time">${fmtDateTime(a.created_at)}</div>
        </div>`).join('')}</div>` : '<div class="empty">No approval decisions yet</div>'}
    </div></div>
  </section>`;
}

function panePromotion(d, userOptions) {
  const chStatus = (name, lbl, icon, val) => `
    <div class="field" data-f="${name}"><label><i data-lucide="${icon}" style="width:13px;height:13px;vertical-align:-2px"></i> ${lbl}</label>
      <select name="${name}">${selectOptions(CHANNEL_STATUSES, val || 'not_posted')}</select></div>`;
  const metric = (name, lbl, val) => `
    <div class="field" data-f="${name}"><label>${lbl}</label>
      <input type="number" min="0" name="${name}" value="${Number(val || 0)}"></div>`;
  return `
  <section class="tab-pane" data-pane="promotion" hidden>
    <div class="card"><div class="card-head"><h3>Posting</h3>${badge(d.posting_status)}</div><div class="card-body">
      <div class="form-row-3">
        <div class="field" data-f="scheduled_at"><label>Posting date & time</label>
          <input type="datetime-local" name="scheduled_at" value="${d.scheduled_at ? String(d.scheduled_at).replace(' ', 'T').slice(0, 16) : ''}"></div>
        <div class="field" data-f="posted_by"><label>Posted by</label>
          <select name="posted_by">${userOptions(d.posted_by)}</select></div>
        <div class="field"><label>Posted at</label>
          <input value="${d.posted_at ? fmtDateTime(d.posted_at) : 'Not posted yet'}" disabled></div>
      </div>
      <div class="form-row-3">
        ${chStatus('instagram_status', 'Instagram status', 'instagram', d.instagram_status)}
        ${chStatus('facebook_status', 'Facebook status', 'facebook', d.facebook_status)}
        ${chStatus('youtube_status', 'YouTube status', 'youtube', d.youtube_status)}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${d.status === 'approved' ? '<button class="btn btn-soft btn-sm" data-quick-status="scheduled">Mark scheduled</button>' : ''}
        ${['approved', 'scheduled'].includes(d.status) ? '<button class="btn btn-success btn-sm" data-quick-status="posted">Mark posted</button>' : ''}
      </div>
    </div></div>

    <div class="card"><div class="card-head"><h3>Performance</h3>
      <span class="hint" style="margin:0">Enter numbers from the platform — saved with Save Draft</span></div>
    <div class="card-body">
      <div class="form-row-3">
        ${metric('metric_views', '👁 Views', d.metric_views)}
        ${metric('metric_reach', '📡 Reach', d.metric_reach)}
        ${metric('metric_likes', '❤️ Likes', d.metric_likes)}
      </div>
      <div class="form-row-3">
        ${metric('metric_comments', '💬 Comments', d.metric_comments)}
        ${metric('metric_shares', '🔁 Shares', d.metric_shares)}
        ${metric('metric_saves', '🔖 Saved', d.metric_saves)}
      </div>
    </div></div>
  </section>`;
}

function panePayments(c) {
  return `
  <section class="tab-pane" data-pane="payments" hidden>
    <div class="card"><div class="card-head"><h3>Client Billing</h3>
      <a class="link-btn" href="#/payments?client_id=${TW.d.client_id}">Open payments →</a></div>
    <div class="card-body">
      <div class="grid grid-3" style="gap:12px" id="twPaySummary">
        <div><div class="t-sub">Package amount</div><strong>${fmtMoney(c.package_amount)}</strong><div class="t-sub">${esc(c.monthly_package || '')} · ${label(c.payment_plan || 'monthly')}</div></div>
        <div><div class="t-sub">Processing fee</div><strong id="twFee">—</strong></div>
        <div><div class="t-sub">Final amount</div><strong id="twFinal" style="color:var(--primary)">—</strong></div>
      </div>
    </div></div>
    <div class="card"><div class="card-head"><h3>Invoices & Payments</h3></div>
      <div class="card-body flush table-wrap" id="twInvoices"><div class="empty">Loading…</div></div>
    </div>
  </section>`;
}

function paneAnalytics(d, ai) {
  const m = (lbl, v) => `<div class="stat"><div><div class="s-val">${fmtNum(v)}</div><div class="s-label">${lbl}</div></div></div>`;
  return `
  <section class="tab-pane" data-pane="analytics" hidden>
    <div class="card"><div class="card-head"><h3>This Task's Performance</h3>
      <a class="link-btn" href="#/analytics?client_id=${d.client_id}">Full client analytics →</a></div>
    <div class="card-body">
      <div class="grid stats-grid">
        ${m('Views', d.metric_views)}${m('Reach', d.metric_reach)}${m('Likes', d.metric_likes)}
        ${m('Comments', d.metric_comments)}${m('Shares', d.metric_shares)}${m('Saved', d.metric_saves)}
      </div>
      <div class="divider"></div>
      <div class="grid grid-3" style="gap:12px">
        <div><div class="t-sub">AI quality score</div><strong style="color:${d.ai_score ? scoreColor(d.ai_score) : 'inherit'}">${d.ai_score ? d.ai_score + '/100' : '—'}</strong></div>
        <div><div class="t-sub">Posted at</div><strong>${d.posted_at ? fmtDateTime(d.posted_at) : 'Not posted'}</strong></div>
        <div><div class="t-sub">Best posting time (AI)</div><strong>${esc(ai?.best_time || '—')}</strong></div>
      </div>
    </div></div>
  </section>`;
}

function paneActivity() {
  return `
  <section class="tab-pane" data-pane="activity" hidden>
    <div class="card"><div class="card-head"><h3>Task Timeline</h3></div>
      <div class="card-body" id="twActivity"><div class="empty">Loading timeline…</div></div>
    </div>
  </section>`;
}

function paneComments(d) {
  return `
  <section class="tab-pane" data-pane="comments" hidden>
    <div class="card"><div class="card-head"><h3>Discussion</h3>
      <span class="hint" style="margin:0">Admins, editors and the client all see this thread</span></div>
    <div class="card-body">
      <div id="twComments">${d.comments.length ? d.comments.map(commentHtml).join('') : '<div class="empty">No comments yet — start the conversation.</div>'}</div>
      <div class="divider"></div>
      <div class="comment-box" style="position:relative">
        <textarea id="twCommentInput" placeholder="Write a comment…  Use @ to mention a teammate"></textarea>
        <div class="cb-toolbar">
          <button class="btn btn-ghost btn-sm" id="twMentionBtn"><i data-lucide="at-sign"></i> Mention</button>
          <button class="btn btn-ghost btn-sm" id="twAttachImg"><i data-lucide="image-plus"></i> Image</button>
          <button class="btn btn-ghost btn-sm" id="twAttachFile"><i data-lucide="paperclip"></i> File</button>
          <span class="chip-row" id="twAttachChips"></span>
          <button class="btn btn-primary btn-sm" id="twPostComment" style="margin-left:auto"><i data-lucide="send"></i> Comment</button>
        </div>
      </div>
    </div></div>
  </section>`;
}

function commentHtml(cm) {
  const attachments = (() => { try { return typeof cm.attachments === 'string' ? JSON.parse(cm.attachments || '[]') : (cm.attachments || []); } catch { return []; } })();
  let msg = esc(cm.message);
  // Highlight @mentions of known people
  const names = new Set(TW.team.map((u2) => u2.name).concat(cm.author_name || []));
  names.forEach((n) => {
    if (!n) return;
    msg = msg.split(`@${esc(n)}`).join(`<span class="mention">@${esc(n)}</span>`);
  });
  const isImg = (u2) => /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u2);
  const roleBadge = cm.author_role === 'client' ? 'b-blue' : cm.author_role === 'super_admin' ? 'b-violet' : 'b-gray';
  return `
    <div class="comment role-${esc(cm.author_role || 'admin')}">
      <div class="avatar">${esc((cm.author_name || '?')[0].toUpperCase())}</div>
      <div style="min-width:0;flex:1">
        <div class="c-head">
          <span class="c-author">${esc(cm.author_name || 'Unknown')}</span>
          <span class="badge ${roleBadge}">${label(cm.author_role || 'admin')}</span>
          <span class="c-time">${fmtDateTime(cm.created_at)}</span>
        </div>
        <div class="c-msg">${msg}</div>
        ${attachments.length ? `<div class="c-files">${attachments.map((a) => `
          <a class="c-file" href="${esc(a.url)}" target="_blank" rel="noopener">
            ${isImg(a.url) ? `<img src="${esc(a.url)}" alt="">` : '<i data-lucide="paperclip"></i>'} ${esc(a.name || 'Attachment')}</a>`).join('')}</div>` : ''}
      </div>
    </div>`;
}

function paneHistory(d) {
  const total = d.versions.length;
  return `
  <section class="tab-pane" data-pane="history" hidden>
    <div class="card"><div class="card-head"><h3>Version History</h3>
      <select id="twVerFilter" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:.78rem">
        <option value="">All fields</option>
        ${[...new Set(d.versions.map((v) => v.field))].map((f) => `<option value="${f}">${label(f)}</option>`).join('')}
      </select></div>
    <div class="card-body">
      <div class="feedback-item" style="background:var(--primary-soft)">
        <strong>Final / current version</strong> — what the task holds right now. Every change below is kept forever; restoring never deletes history, it adds a new version on top.
      </div>
      <div id="twVersions">
        ${total ? d.versions.map((v, i) => `
        <div class="ver-item" data-field="${esc(v.field)}">
          <div class="ver-head">
            <span class="ver-no">Version ${total - i}</span>
            <span class="badge b-gray">${label(v.field)}</span>
            <span class="t-sub">${esc(v.actor_name || 'Unknown')} · ${fmtDateTime(v.created_at)}</span>
            <button class="btn btn-outline btn-sm" style="margin-left:auto" data-restore="${v.id}" data-restore-field="${esc(v.field)}">
              <i data-lucide="rotate-ccw"></i> Restore previous</button>
          </div>
          <div class="diff">
            <div class="diff-old">${esc(v.old_value || '(empty)')}</div>
            <div class="diff-new">${esc(v.new_value || '(empty)')}</div>
          </div>
        </div>`).join('') : '<div class="empty">No changes recorded yet — edits to title, caption, notes and links will appear here.</div>'}
      </div>
    </div></div>
  </section>`;
}

/* ================= PANE WIRING ================= */

function wireAIPane() {
  const busy = async (btn, fn) => {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Working…';
    try { await fn(); } catch (ex) { toastErr(ex.message); }
    btn.disabled = false;
    btn.innerHTML = old;
    icons();
  };

  /** Refresh AI output + score without a full re-render (drafts survive). */
  const refreshAI = async () => {
    const r = await Api.get(`/api/deliverables/${TW.d.id}`);
    TW.d.ai_analysis = r.data.ai_analysis;
    TW.d.ai_score = r.data.ai_score;
    const panel = $('#twAiPanel');
    if (panel) panel.innerHTML = r.data.ai_analysis ? aiPanelHtml(r.data.ai_analysis) : '<div class="t-sub">No AI output yet.</div>';
    const prov = $('#twAiProvider');
    if (prov && r.data.ai_analysis) prov.textContent = r.data.ai_analysis.provider || '';
    icons();
  };

  $$('[data-ai]').forEach((b) => (b.onclick = () => busy(b, async () => {
    const kind = b.dataset.ai;
    if (kind === 'analyze') { await Api.post(`/api/ai/analyze/${TW.d.id}`); toastOk('AI analysis complete'); }
    if (kind === 'quality') { const res = await Api.post(`/api/ai/quality/${TW.d.id}`); toastOk(`Quality score: ${res.data.overall_score}/100`); }
    if (kind === 'caption') {
      const res = await Api.post(`/api/ai/caption/${TW.d.id}`);
      toastOk('Caption generated and saved to the caption library');
      const cap = page.querySelector('[name="caption"]');
      if (cap && res.data.caption) { cap.value = res.data.caption; TW.orig.caption = res.data.caption; twRefreshDirtyUI(); }
    }
    await refreshAI();
  })));

  $$('[data-ai-gen]').forEach((b) => (b.onclick = () => busy(b, async () => {
    const res = await Api.post(`/api/ai/generate/${TW.d.id}`, { field: b.dataset.aiGen });
    toastOk(res.message);
    if (res.data.detected_language) {
      const el = $('#twDetectedLang');
      if (el) el.textContent = res.data.detected_language;
    }
    await refreshAI();
  })));

  const detectBtn = $('#twDetectBrand');
  if (detectBtn) detectBtn.onclick = () => busy(detectBtn, async () => {
    const img = twVal('thumbnail_url') || TW.d.thumbnail_url || (TW.d.client && TW.d.client.company_logo_url);
    const out = $('#twDetectOut');
    try {
      const res = await Api.post('/api/ai/detect-client', {
        image_url: img || undefined,
        brand_text: img ? undefined : (TW.d.client?.company_name || TW.d.company_name),
      });
      const dd = res.data;
      const extracted = Object.entries(dd.extracted || {}).filter(([, v]) => v);
      out.innerHTML = `
        ${dd.match
          ? `<div class="feedback-item" style="background:var(--green-bg);color:var(--green)">✓ Branding matches <strong>${esc(dd.match.company_name)}</strong> (${Math.round(dd.match.confidence * 100)}% confidence)${dd.match.client_id === TW.d.client_id ? ' — correct client' : ' — ⚠ different client than this task!'}</div>`
          : '<div class="feedback-item" style="background:var(--amber-bg);color:var(--amber)">No confident brand match — check the logo/watermark/footer manually.</div>'}
        ${extracted.length ? extracted.map(([k, v]) => `<div class="kv"><span class="k">${label(k)} detected</span><span class="v">${esc(v)}</span></div>`).join('') : '<div class="t-sub">No cues extracted (enable OpenAI vision for image detection).</div>'}`;
    } catch (ex) {
      out.innerHTML = `<div class="feedback-item" style="background:var(--red-bg);color:var(--red)">⚠ ${esc(ex.message)}</div>`;
    }
  });

}

function wirePayments() {
  // Fee settings may be super-admin-only; degrade gracefully.
  const pkg = Number(TW.d.client?.package_amount || 0);
  Api.get('/api/settings').then((sr) => {
    const feePct = Number(sr.data.processing_fee_percent || 0);
    const fee = Math.round(pkg * (feePct / 100) * 100) / 100;
    const feeEl = $('#twFee'); const finEl = $('#twFinal');
    if (feeEl) feeEl.textContent = `${fmtMoney(fee)} (${feePct}%)`;
    if (finEl) finEl.textContent = fmtMoney(pkg + fee);
  }).catch(() => {
    const feeEl = $('#twFee'); const finEl = $('#twFinal');
    if (feeEl) feeEl.textContent = '—';
    if (finEl) finEl.textContent = fmtMoney(pkg);
  });
  Api.get(`/api/payments/invoices?client_id=${TW.d.client_id}&limit=8`).then((ir) => {
    const el = $('#twInvoices');
    if (!el) return;
    el.innerHTML = ir.data.length ? `
      <table class="tbl"><thead><tr><th>Invoice number</th><th class="num">Amount</th><th>Payment status</th><th>Transaction</th><th>Payment date</th><th></th></tr></thead>
      <tbody>${ir.data.map((i) => `
        <tr>
          <td class="t-main">${esc(i.invoice_no)}</td>
          <td class="num">${fmtMoney(i.total)}</td>
          <td>${badge(i.status)}</td>
          <td class="t-sub">${esc(i.txn_id || i.razorpay_payment_id || '—')}</td>
          <td>${i.paid_at ? fmtDate(i.paid_at) : fmtDate(i.due_date)}</td>
          <td class="row-actions"><a class="btn btn-ghost btn-sm" href="#/invoice/${i.id}">View</a></td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No invoices for this client yet</div>';
  }).catch(() => { const el = $('#twInvoices'); if (el) el.innerHTML = '<div class="empty">Could not load invoices</div>'; });
}

async function twLoadActivity() {
  const el = $('#twActivity');
  if (!el || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  try {
    const r = await Api.get(`/api/activity?entity_type=deliverable&entity_id=${TW.d.id}&limit=60`);
    const events = r.data.slice().reverse(); // chronological
    const iconFor = (a) => {
      if (a.startsWith('status:')) return a.includes('reject') || a.includes('cancel') ? 'bad' : a.includes('approv') || a.includes('complet') || a.includes('post') ? 'good' : '';
      if (a === 'create') return 'good';
      if (a === 'delete') return 'bad';
      return 'muted';
    };
    const rows = [
      { action: 'create', description: `Task created${TW.d.created_by_name ? ' by ' + TW.d.created_by_name : ''}`, created_at: TW.d.created_at, actor_name: TW.d.created_by_name },
      ...events.filter((e) => e.action !== 'create'),
    ];
    el.innerHTML = `<div class="timeline">${rows.map((e) => `
      <div class="tl-item">
        <span class="tl-dot ${iconFor(e.action)}"></span>
        <div class="tl-title">${label(e.action.replace('status:', 'Status → '))}</div>
        <div class="tl-body">${esc(e.description || '')}</div>
        <div class="tl-time">${esc(e.actor_name || 'System')} · ${fmtDateTime(e.created_at)}</div>
      </div>`).join('')}</div>`;
  } catch {
    el.innerHTML = '<div class="empty">Could not load the activity timeline</div>';
  }
}

function wireComments() {
  const input = $('#twCommentInput');
  if (!input) return;

  const chips = $('#twAttachChips');
  const renderChips = () => {
    chips.innerHTML = TW.attachments.map((a, i) => `
      <span class="badge b-gray">${esc(a.name)} <button data-rm-att="${i}" style="font-weight:800;margin-left:2px">✕</button></span>`).join('');
    $$('[data-rm-att]', chips).forEach((b) => (b.onclick = () => { TW.attachments.splice(Number(b.dataset.rmAtt), 1); renderChips(); }));
  };

  const attach = (kind) => {
    const m = modal({
      title: kind === 'img' ? 'Attach image' : 'Attach file',
      body: `
        <div class="field"><label>${kind === 'img' ? 'Image URL' : 'File URL'} *</label>
          <input id="attUrl" placeholder="https://… (Drive share link or direct URL)"></div>
        <div class="field"><label>Display name</label><input id="attName" placeholder="e.g. Reference ${kind === 'img' ? 'image' : 'document'}"></div>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button><button class="btn btn-primary" data-y>Attach</button>`,
    });
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = () => {
      const url = $('#attUrl').value.trim();
      if (!/^https?:\/\//i.test(url)) return toastErr('Enter a valid http(s) URL');
      TW.attachments.push({ url, name: $('#attName').value.trim() || (kind === 'img' ? 'Image' : 'File') });
      renderChips();
      m.close();
    };
  };
  $('#twAttachImg').onclick = () => attach('img');
  $('#twAttachFile').onclick = () => attach('file');

  // @mention picker
  const mentionables = TW.team.map((u2) => u2.name)
    .concat(TW.d.client?.contact_person || TW.d.client?.company_name || []);
  $('#twMentionBtn').onclick = (e) => {
    e.stopPropagation();
    document.querySelector('.mention-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'mention-pop';
    pop.innerHTML = mentionables.map((n) => `<button data-mention="${esc(n)}">@ ${esc(n)}</button>`).join('') || '<div class="empty">No one to mention</div>';
    const btn = $('#twMentionBtn');
    btn.parentElement.style.position = 'relative';
    pop.style.bottom = '40px';
    pop.style.left = '0';
    btn.parentElement.appendChild(pop);
    $$('[data-mention]', pop).forEach((b) => (b.onclick = () => {
      const name = b.dataset.mention;
      TW.mentioned.add(name);
      const pos = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, pos)}@${name} ${input.value.slice(pos)}`;
      input.focus();
      pop.remove();
    }));
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
  };

  $('#twPostComment').onclick = async () => {
    const message = input.value.trim();
    if (!message) return toastErr('Write a comment first');
    // pick up typed @mentions of known names too
    mentionables.forEach((n) => { if (n && message.includes(`@${n}`)) TW.mentioned.add(n); });
    try {
      const res = await Api.post(`/api/deliverables/${TW.d.id}/comments`, {
        message,
        mentions: [...TW.mentioned],
        attachments: TW.attachments,
      });
      TW.d.comments.push(res.data);
      const list = $('#twComments');
      if (list.querySelector('.empty')) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', commentHtml(res.data));
      input.value = '';
      TW.attachments = [];
      TW.mentioned = new Set();
      renderChips();
      icons();
      toastOk('Comment posted');
    } catch (ex) { toastErr(errText(ex)); }
  };
}

function wireHistory() {
  const filter = $('#twVerFilter');
  if (filter) filter.onchange = () => {
    $$('#twVersions .ver-item').forEach((el) => {
      el.style.display = !filter.value || el.dataset.field === filter.value ? '' : 'none';
    });
  };
  $$('[data-restore]').forEach((b) => (b.onclick = () =>
    confirmModal('Restore version',
      `Restore "${label(b.dataset.restoreField)}" to its value before this change? The current value stays in history as a new version.`,
      async () => {
        try {
          const res = await Api.post(`/api/deliverables/${TW.d.id}/versions/${b.dataset.restore}/restore`);
          toastOk(res.message);
          TW.activeTab = 'history';
          await twReload();
        } catch (ex) { toastErr(errText(ex)); }
      }, false)));
}
