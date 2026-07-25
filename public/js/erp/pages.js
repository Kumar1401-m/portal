/**
 * ERP pages — every module page except the Task Workspace (task.js).
 * Dashboard · Today · Calendar · Clients (+full-page editor) · Content ·
 * Captions · Approvals · Payments (+invoice) · Analytics · Reports ·
 * Activity · Team · Settings · AI Detect · Scripts · Thumbnails
 */
'use strict';

/* ============ DASHBOARD ============ */
ERP.register('dashboard', async function renderDashboard() {
  page.innerHTML = '<div class="empty">Loading dashboard…</div>';
  const r = await Api.get('/api/dashboard/admin');
  const d = r.data;
  const sstat = (icon, val, lbl, cls, link) => `
    <a class="stat stat-solid ${cls}" href="${link || '#/dashboard'}">
      <div class="s-icon"><i data-lucide="${icon}"></i></div>
      <div class="s-val">${val}</div><div class="s-label">${lbl}</div>
    </a>`;
  // Pending Content already includes items awaiting approval — don't add them again.
  const totalPending = Number(d.deliverables.month_pending || 0);

  page.innerHTML = `
    <div class="banner">
      <div>${esc(user.name)} · Agency Dashboard</div>
      <div class="head-actions">
        <button class="btn btn-pink btn-sm" id="dashRefresh"><i data-lucide="refresh-cw"></i> Refresh</button>
        <a class="btn btn-outline btn-sm" href="#/tasks/new" style="background:#fff"><i data-lucide="plus"></i> New Task</a>
      </div>
    </div>

    <div class="grid stats-grid" style="margin-bottom:16px">
      ${sstat('users', fmtNum(d.clients.total), 'Total Clients', 'sc-green', '#/clients')}
      ${sstat('clapperboard', fmtNum(d.deliverables.month_total), 'Content This Month', 'sc-violet', '#/content?month=' + thisMonth())}
      ${sstat('hourglass', fmtNum(d.deliverables.month_pending), 'Pending Content', 'sc-orange', '#/content')}
      ${sstat('hourglass', fmtNum(d.pending_approvals), 'Awaiting Client Approval', 'sc-blue', '#/approvals?tab=content')}
      ${sstat('pencil', fmtNum(d.changes_requested), 'Changes Requested', 'sc-red', '#/approvals?tab=changes')}
      ${sstat('circle-check', fmtNum(d.deliverables.month_completed), 'Approved / Completed', 'sc-lime', '#/content?status=completed')}
      ${sstat('calendar-clock', fmtNum(d.deliverables.today), "Today's Tasks", 'sc-blue', '#/today')}
      ${sstat('alarm-clock-off', fmtNum(d.deliverables.overdue), 'Overdue', 'sc-red', '#/content?due=overdue')}
      ${sstat('wallet', fmtMoney(d.payments.pending_amount), 'Pending Payments', 'sc-amber', '#/payments?status=pending')}
      ${sstat('banknote', fmtMoney(d.payments.month_received), 'Monthly Revenue', 'sc-green', '#/payments?status=paid')}
      ${sstat('calendar-arrow-up', fmtNum(d.deliverables.upcoming), 'Upcoming', 'sc-gold', '#/content?due=upcoming')}
    </div>

    <a class="hero-card sc-orange" href="#/content" style="display:block;margin-bottom:16px">
      <div class="hc-icon">⏳</div>
      <div class="hc-label">Total Pending Content</div>
      <div class="hc-val">${fmtNum(totalPending)}</div>
    </a>

    <div class="grid grid-23" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>Revenue — last 6 months</h3></div>
        <div class="card-body"><canvas id="chartRevenue" data-h="230" style="width:100%"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>This month's content status</h3></div>
        <div class="card-body" style="display:flex;flex-direction:column;align-items:center;gap:12px">
          <canvas id="chartStatus" data-h="180" style="width:180px"></canvas>
          <div class="chip-row" id="statusLegend"></div>
        </div>
      </div>
    </div>

    <div class="grid grid-23" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>Today's tasks</h3><a class="link-btn" href="#/today">View all</a></div>
        <div class="card-body flush table-wrap" id="todayTasks"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Client progress — ${label(thisMonth())}</h3></div>
        <div class="card-body" id="clientProgress"></div>
      </div>
    </div>

    <div class="grid grid-23">
      <div class="card">
        <div class="card-head"><h3>Calendar</h3><a class="link-btn" href="#/calendar">Open full calendar</a></div>
        <div class="card-body"><div id="miniCal"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Recent activity</h3></div>
        <div class="card-body flush" id="recentActivity"></div>
      </div>
    </div>`;

  $('#dashRefresh').onclick = () => ERP.routes.dashboard().then(icons);

  const months = d.charts.revenue.map((x) => ({ label: x.month.slice(5), value: Number(x.total) }));
  barChart($('#chartRevenue'), months.length ? months : [{ label: '—', value: 0 }], { money: true });
  const dist = d.charts.status_distribution.map((x) => ({ label: statusLabel(x.status), value: x.n }));
  donutChart($('#chartStatus'), dist.length ? dist : [{ label: 'None', value: 1 }], $('#statusLegend'));

  const todayRes = await Api.get('/api/deliverables?due=today&limit=8');
  $('#todayTasks').innerHTML = todayRes.data.length ? `
    <table class="tbl"><thead><tr><th>Client</th><th>Content</th><th>Platform</th><th>Status</th></tr></thead>
    <tbody>${todayRes.data.map((t) => `
      <tr class="clickable" data-nav="/tasks/${t.id}">
        <td class="t-main">${esc(t.company_name)}</td>
        <td>${esc(t.title)}</td>
        <td><span class="badge b-primary">${label(t.platform)}</span></td>
        <td>${statusBadge(t.status)}</td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="empty">🎉 Nothing due today</div>';

  $('#clientProgress').innerHTML = d.client_progress.length
    ? d.client_progress.map((c) => {
        const target = Math.max(Number(c.monthly_deliverables) || Number(c.planned) || 1, 1);
        const pct = Math.min(100, Math.round((Number(c.completed) / target) * 100));
        return `<div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:.84rem;margin-bottom:4px">
            <strong>${esc(c.company_name)}</strong><span>${c.completed}/${target}</span></div>
          <div class="progress"><div style="width:${pct}%"></div></div></div>`;
      }).join('')
    : '<div class="empty">No active clients yet</div>';

  const calRes = await Api.get(`/api/deliverables/calendar?month=${thisMonth()}`);
  calendar($('#miniCal'), thisMonth(), calRes.data.items, {
    mini: true,
    onDayClick: (date) => nav(`/calendar?date=${date}`),
    onNav: () => nav('/calendar'),
  });

  $('#recentActivity').innerHTML = d.recent_activities.length
    ? d.recent_activities.slice(0, 7).map((a) => `
      <div class="notif-item">
        <div class="n-title">${esc(a.actor_name || 'System')} · <span style="font-weight:500">${esc(label(a.action))}</span></div>
        <div class="n-body">${esc(a.description || '')}</div>
        <div class="n-time">${timeAgo(a.created_at)}</div>
      </div>`).join('')
    : '<div class="empty">No activity yet</div>';
});

/* ============ POSTER WORKFLOW (shared stage helpers) ============
 * Poster flow: admin creates → designer designs & submits a drive link →
 * ADMIN reviews & approves → CLIENT approves → complete (reflects to designer).
 *   To design   : pending / resolved / changes_requested  (designer must act)
 *   Admin review: caption_ready / editing / raw_uploaded   (designer submitted)
 *   Client review: review                                  (admin approved, sent to client)
 *   Completed   : approved / scheduled / posted / completed (client approved) */
const POSTER_DONE = ['approved', 'scheduled', 'posted', 'completed'];
const POSTER_TODO = ['pending', 'resolved', 'changes_requested'];
const posterDone = (d) => POSTER_DONE.includes(d.status);
const posterTodo = (d) => POSTER_TODO.includes(d.status);
const posterInReview = (d) => !posterDone(d) && !posterTodo(d); // caption_ready / review / editing…
function posterStageBadge(d) {
  if (d.status === 'changes_requested') return '<span class="badge b-red">Changes — redo</span>';
  if (POSTER_DONE.includes(d.status)) return '<span class="badge b-green">Completed</span>';
  if (d.status === 'review') return '<span class="badge b-violet">Client review</span>';
  if (posterInReview(d)) return '<span class="badge b-blue">Admin review</span>';
  return '<span class="badge b-amber">To design</span>';
}

/* ============ POSTER DESIGNER — my assigned tasks ============ */
ERP.register('poster', async function renderPosterDashboard(params) {
  page.innerHTML = '<div class="empty">Loading your tasks…</div>';
  const r = await Api.get('/api/deliverables?limit=200');
  const rows = r.data;
  const isDone = posterDone; // "completed" = client-approved

  // Date buckets for the quick-access cards.
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const dueOf = (d) => (d.due_date ? new Date(d.due_date) : null);
  const isToday = (d) => { const x = dueOf(d); return !!x && x.toDateString() === today0.toDateString(); };
  const isOverdue = (d) => { const x = dueOf(d); return !!x && x < today0 && !isDone(d); };

  const FILTERS = {
    all: () => true,
    todo: posterTodo,          // designer must act (to design / redo)
    review: posterInReview,    // waiting on admin/client
    done: posterDone,          // client approved
    overdue: isOverdue,
  };
  const count = (f) => rows.filter(f).length;
  const totalDone = count(isDone);

  // Quick-access stat card (click to filter the task list below).
  const card = (icon, val, lbl, cls, filter) => `
    <div class="stat stat-solid ${cls}" data-filter="${filter}" role="button" tabindex="0" style="cursor:pointer">
      <div class="s-icon"><i data-lucide="${icon}"></i></div>
      <div class="s-val">${val}</div><div class="s-label">${lbl}</div>
    </div>`;

  page.innerHTML = `
    <div class="banner"><div>${esc(user.name)} · My Poster Tasks
        <span style="font-weight:400;opacity:.85;font-size:.82rem">· ${totalDone}/${rows.length} completed</span></div>
      <div class="head-actions"><button class="btn btn-pink btn-sm" id="pdRefresh"><i data-lucide="refresh-cw"></i> Refresh</button></div>
    </div>

    <div class="grid stats-grid" style="margin-bottom:16px">
      ${card('layout-grid', rows.length, 'Total Posters', 'sc-violet', 'all')}
      ${card('pencil-ruler', count(FILTERS.todo), 'To Design', 'sc-orange', 'todo')}
      ${card('hourglass', count(FILTERS.review), 'In Review', 'sc-blue', 'review')}
      ${card('circle-check', totalDone, 'Completed', 'sc-lime', 'done')}
      ${card('alarm-clock-off', count(FILTERS.overdue), 'Overdue', 'sc-red', 'overdue')}
    </div>

    <div class="card"><div class="card-head"><h3 id="pdTitle">My poster tasks</h3></div><div class="card-body flush table-wrap" id="pdTable"></div></div>`;

  const TITLES = { all: 'My poster tasks', todo: 'To design', review: 'In review (admin / client)', done: 'Completed', overdue: 'Overdue' };
  const wireRows = () => {
    $$('[data-stop]', $('#pdTable')).forEach((a) => (a.onclick = (e) => e.stopPropagation()));
    $$('[data-open]', $('#pdTable')).forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const d = rows.find((x) => x.id === Number(b.dataset.open));
      if (d) posterTaskModal(d);
    }));
  };
  const renderList = (list, title) => {
    $('#pdTitle').textContent = title;
    $('#pdTable').innerHTML = list.length ? `
      <table class="tbl"><thead><tr>
        <th>#</th><th>Client</th><th>Title</th><th>Brief</th><th>Due</th><th>Design</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${list.map((d, i) => `
        <tr class="clickable" data-open="${d.id}">
          <td>${i + 1}</td>
          <td class="t-main">${esc(d.company_name || '')}</td>
          <td>${esc(d.title)}</td>
          <td>${d.content_hook ? esc(String(d.content_hook).slice(0, 40)) + '…' : '<span class="t-sub">—</span>'}</td>
          <td style="white-space:nowrap">${fmtDate(d.due_date)}</td>
          <td>${d.edited_link ? `<a class="link-btn" href="${esc(d.edited_link)}" target="_blank" rel="noopener" data-stop>View</a>` : '<span class="t-sub">—</span>'}</td>
          <td>${posterStageBadge(d)}</td>
          <td class="row-actions"><button class="btn btn-primary btn-sm" data-open="${d.id}">Open</button></td>
        </tr>`).join('')}
      </tbody></table>` : '<div class="empty">Nothing here right now.</div>';
    wireRows();
  };

  const renderFilter = (key) => renderList(rows.filter(FILTERS[key] || FILTERS.all), TITLES[key] || TITLES.all);

  $('#pdRefresh').onclick = () => route();
  // Clickable cards filter the list; highlight the active one.
  const cards = $$('[data-filter]');
  const clearActive = () => cards.forEach((c) => (c.style.outline = ''));
  const activate = (el) => {
    clearActive();
    el.style.outline = '3px solid rgba(255,255,255,.85)';
    el.style.outlineOffset = '-3px';
    renderFilter(el.dataset.filter);
  };
  cards.forEach((c) => {
    c.onclick = () => activate(c);
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(c); } };
  });
  renderFilter('all');
  icons();
});

/* ============ POSTER DESIGNER · TODAY'S TASKS (priority worklist) ============ */
ERP.register('poster-today', async function renderPosterToday() {
  page.innerHTML = '<div class="empty">Loading…</div>';
  const [overdueRes, todayRes] = await Promise.all([
    Api.get('/api/deliverables?due=overdue&limit=200'),
    Api.get('/api/deliverables?due=today&limit=200'),
  ]);
  const seen = new Set();
  const list = [];
  const add = (arr, overdue) => arr.forEach((d) => {
    if (!seen.has(d.id)) { seen.add(d.id); list.push({ ...d, _overdue: overdue }); }
  });
  add(overdueRes.data, true);   // overdue first
  add(todayRes.data, false);

  const prBadge = (p) => {
    const m = { urgent: 'b-red', high: 'b-amber', medium: 'b-blue', low: 'b-gray' };
    return p ? `<span class="badge ${m[p] || 'b-gray'}">${esc(p)}</span>` : '<span class="t-sub">—</span>';
  };

  page.innerHTML = `
    <div class="banner"><div>Today's Tasks
        <span style="font-weight:400;opacity:.85;font-size:.82rem">· ${list.length} to work on</span></div>
      <div class="head-actions"><button class="btn btn-pink btn-sm" id="ptRefresh"><i data-lucide="refresh-cw"></i> Refresh</button></div>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="ptTable"></div></div>`;
  $('#ptRefresh').onclick = () => route();
  $('#ptTable').innerHTML = list.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Client</th><th>Title</th><th>Type</th><th>Priority</th><th>Due</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${list.map((d, i) => `
      <tr class="clickable" data-open="${d.id}">
        <td>${i + 1}</td>
        <td class="t-main">${esc(d.company_name || '')}</td>
        <td>${esc(d.title)}</td>
        <td><span class="badge b-green">${esc(d.video_type || label(d.platform))}</span></td>
        <td>${prBadge(d.priority)}</td>
        <td style="white-space:nowrap">${d._overdue ? '<span class="badge b-red">Overdue</span> ' : ''}${fmtDate(d.due_date)}</td>
        <td>${posterStageBadge(d)}</td>
        <td class="row-actions"><button class="btn btn-primary btn-sm" data-open="${d.id}">Open</button></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">Nothing due today. You’re all caught up! 🎉</div>';
  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const d = list.find((x) => x.id === Number(b.dataset.open));
    if (d) posterTaskModal(d);
  }));
  icons();
});

/* ============ POSTER DESIGNER · MY CLIENTS (page 1: monthly scorecard) ============
 * Mirrors the admin Client Report, but built entirely from the designer's own
 * (scoped) deliverables list, so they only ever see their own clients. */
ERP.register('poster-clients', async function renderPosterClientsScorecard(params) {
  const month = (params && params.get('month')) || thisMonth();
  page.innerHTML = `
    <div class="banner"><div>My Clients · Monthly Scorecard</div>
      <div class="head-actions">
        <button class="btn btn-outline btn-sm" id="pcPrev" style="background:#fff"><i data-lucide="chevron-left"></i></button>
        <input type="month" id="pcMonth" value="${month}" style="border:0;border-radius:8px;padding:6px 10px;font-weight:600">
        <button class="btn btn-outline btn-sm" id="pcNext" style="background:#fff"><i data-lucide="chevron-right"></i></button>
      </div>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="pcTable"><div class="empty">Loading…</div></div></div>`;
  $('#pcPrev').onclick = () => nav(`/poster-clients?month=${monthShift(month, -1)}`);
  $('#pcNext').onclick = () => nav(`/poster-clients?month=${monthShift(month, 1)}`);
  $('#pcMonth').onchange = () => nav(`/poster-clients?month=${$('#pcMonth').value}`);

  // Poster designer scorecard = posters (not the video YT/Reels split).
  // "Completed" = client-approved (shared posterDone).
  const isPoster = (d) => d.video_type === 'Poster' || d.platform === 'poster';
  const r = await Api.get(`/api/deliverables?month=${month}&limit=500`);
  const byClient = {};
  r.data.forEach((d) => {
    if (!isPoster(d)) return; // only posters count on the poster designer's scorecard
    const k = d.client_id;
    if (!byClient[k]) byClient[k] = { id: d.client_id, name: d.company_name || 'Unknown', total: 0, done: 0 };
    byClient[k].total++;
    if (posterDone(d)) byClient[k].done++;
  });
  const clients = Object.values(byClient).sort((a, b) => a.name.localeCompare(b.name));
  $('#pcTable').innerHTML = clients.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Name of the Client</th>
      <th>Posters</th><th>Completed</th><th>% Completed</th><th></th>
    </tr></thead><tbody>
    ${clients.map((c, i) => `
      <tr class="clickable" data-nav="/poster-clients/${c.id}?month=${month}">
        <td>${i + 1}</td>
        <td class="t-main">${esc(c.name)}</td>
        <td>${c.total}</td><td>${c.done}</td>
        <td style="min-width:150px">${pctBar(c.done, c.total)}</td>
        <td class="row-actions"><span class="link-btn">Open →</span></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No posters for this month.</div>';
  icons();
});

/* ============ POSTER DESIGNER · MY CLIENTS (page 2: per-client month detail) ============ */
ERP.register('poster-client-detail', async function renderPosterClientDetail(id, params) {
  const month = (params && params.get('month')) || thisMonth();
  page.innerHTML = '<div class="empty">Loading…</div>';
  const r = await Api.get(`/api/deliverables?client_id=${id}&month=${month}&limit=200`);
  const rows = r.data;
  const clientName = (rows[0] && rows[0].company_name) || 'Client';
  // Poster designer view: summarise by posters; "Completed" = client-approved.
  const posterCount = rows.filter((d) => d.video_type === 'Poster').length;
  const doneCount = rows.filter(posterDone).length;

  const viewLink = (url) => url
    ? `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener" data-stop>View</a>` : '<span class="t-sub">N/A</span>';
  const trunc = (v, n = 26) => (v && String(v).trim()
    ? esc(String(v).length > n ? String(v).slice(0, n) + '…' : String(v)) : '<span class="t-sub">N/A</span>');
  const editorStatus = (d) => {
    if (['posted', 'completed', 'approved', 'scheduled'].includes(d.status)) return '<span class="badge b-green">Done</span>';
    if (d.status === 'changes_requested') return '<span class="badge b-red">Changes</span>';
    if (['content_review', 'review'].includes(d.status)) return '<span class="badge b-violet">Sent for Approval</span>';
    if (['caption_ready', 'editing', 'raw_uploaded'].includes(d.status)) return '<span class="badge b-blue">In Progress</span>';
    return '<span class="badge b-amber">Yet To Start</span>';
  };

  page.innerHTML = `
    <div class="banner">
      <div><a class="link-btn" href="#/poster-clients?month=${month}" style="color:#fff">← Clients</a> · ${esc(clientName)}</div>
      <div class="head-actions">
        <button class="btn btn-outline btn-sm" id="cdPrev" style="background:#fff"><i data-lucide="chevron-left"></i></button>
        <input type="month" id="cdMonth" value="${month}" style="border:0;border-radius:8px;padding:6px 10px;font-weight:600">
        <button class="btn btn-outline btn-sm" id="cdNext" style="background:#fff"><i data-lucide="chevron-right"></i></button>
      </div>
    </div>
    <div class="chip-row" style="margin-bottom:14px">
      <span class="badge b-violet" style="font-size:.85rem;padding:8px 14px">🖼️ Posters: ${posterCount}</span>
      <span class="badge b-green" style="font-size:.85rem;padding:8px 14px">✅ Completed: ${doneCount}</span>
      <span class="badge b-blue" style="font-size:.85rem;padding:8px 14px">🗂️ Total: ${rows.length}</span>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="cdTable"></div></div>`;

  $('#cdPrev').onclick = () => nav(`/poster-clients/${id}?month=${monthShift(month, -1)}`);
  $('#cdNext').onclick = () => nav(`/poster-clients/${id}?month=${monthShift(month, 1)}`);
  $('#cdMonth').onchange = () => nav(`/poster-clients/${id}?month=${$('#cdMonth').value}`);

  $('#cdTable').innerHTML = rows.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Creative Type</th><th>Post Date</th><th>Promotion</th><th>Shoot</th><th>Editor</th><th>Thumbnail</th>
      <th>Title</th><th>Description</th><th>Content Status</th><th>Editor Status</th><th>Remarks</th><th></th>
    </tr></thead><tbody>
    ${rows.map((d, i) => `
      <tr class="clickable" data-open="${d.id}">
        <td>${i + 1}</td>
        <td><span class="badge b-green">${esc(d.video_type || label(d.platform))}</span></td>
        <td style="white-space:nowrap">${fmtDate(d.scheduled_at || d.due_date)}</td>
        <td>${d.promotion_type ? `<span class="badge b-blue">${esc(d.promotion_type)}</span>` : '<span class="t-sub">N/A</span>'}</td>
        <td>${viewLink(d.raw_drive_link)}</td>
        <td>${viewLink(d.edited_link)}</td>
        <td>${viewLink(d.thumbnail_url)}</td>
        <td>${trunc(d.title, 30)}</td>
        <td>${trunc(d.caption || d.description, 22)}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${editorStatus(d)}</td>
        <td>${trunc(d.reject_reason, 18)}</td>
        <td class="row-actions"><button class="iconbtn" data-open="${d.id}" title="Open" style="color:var(--pink)"><i data-lucide="pencil"></i></button></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No content for this client in this month.</div>';

  $$('[data-stop]').forEach((a) => (a.onclick = (e) => e.stopPropagation()));
  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const d = rows.find((x) => x.id === Number(b.dataset.open));
    if (d) posterTaskModal(d);
  }));
  icons();
});

function posterTaskModal(t) {
  // The designer can only act while it's their turn: a new brief (pending) or a
  // send-back (changes_requested). While in admin/client review or completed,
  // the modal is read-only so they can track the stage without re-submitting.
  const canSubmit = ['pending', 'resolved', 'changes_requested'].includes(t.status);
  const stageMsg = t.status === 'changes_requested'
    ? '✏️ Changes requested — update the design and resubmit.'
    : posterDone(t) ? '✅ Client approved — this poster is complete.'
      : t.status === 'review' ? '⏳ Admin approved — waiting for the client’s approval.'
        : posterInReview(t) ? '⏳ Submitted — waiting for the admin to review your design.'
          : '🎨 Design the poster, then submit your design link.';
  const m = modal({
    title: `${esc(t.video_type || 'Task')} — ${t.title}`,
    body: `<form id="pdForm">
      <div class="chip-row" style="margin-bottom:10px">
        <span class="t-sub">${esc(t.company_name || '')} · ${taskCode(t.id)}</span> ${posterStageBadge(t)}
      </div>
      <div class="hint" style="margin-bottom:10px">${stageMsg}</div>
      ${t.status === 'changes_requested' && t.reject_reason ? `<div style="margin-bottom:12px;padding:9px 12px;border-radius:8px;background:#fff5f5;border:1px solid #ffc9c9;color:#c92a2a;font-size:.85rem">
        <strong>Requested change:</strong> ${esc(t.reject_reason)}</div>` : ''}
      <div class="field"><label>Content brief (what to put on the poster)</label>
        <div class="copy-box" style="white-space:pre-wrap">${esc(t.content_hook || t.caption || t.description || 'No brief provided yet.')}</div></div>
      ${t.thumbnail_url ? `<div class="field"><label>Reference</label>
        <a class="link-btn" href="${esc(t.thumbnail_url)}" target="_blank" rel="noopener">Open reference ↗</a></div>` : ''}
      <div class="field"><label>Your design link (Drive / Canva / image URL)${canSubmit ? ' *' : ''}</label>
        <input id="pdLink" value="${esc(t.edited_link || '')}" placeholder="https://…" ${canSubmit ? '' : 'readonly'}></div>
      ${canSubmit ? `<div class="field"><label>Note to admin (optional)</label>
        <textarea id="pdNote" rows="2" placeholder="Anything the admin should know…"></textarea></div>` : ''}
    </form>`,
    footer: canSubmit
      ? `<button class="btn btn-danger" data-x>Close</button>
         <button class="btn btn-primary" data-y>${t.status === 'changes_requested' ? 'Resubmit Design' : 'Submit Design'}</button>`
      : '<button class="btn btn-danger" data-x>Close</button>',
  });
  icons();
  $('[data-x]', m.foot).onclick = m.close;
  const submitBtn = $('[data-y]', m.foot);
  if (submitBtn) submitBtn.onclick = async () => {
    const link = $('#pdLink', m.el).value.trim();
    if (!link || !/^https?:\/\//i.test(link)) return toastErr('Paste a valid design link (starts with http)');
    const noteEl = $('#pdNote', m.el);
    try {
      await Api.post(`/api/deliverables/${t.id}/poster`, { link, note: (noteEl && noteEl.value.trim()) || undefined });
      toastOk('Design submitted — the admin has been notified');
      m.close();
      route();
    } catch (ex) { toastErr(ex.message); }
  };
}

/* ============ TODAY'S TASKS ============ */
const TODAY_PER_PAGE = 8;

ERP.register('today', async function renderToday(params) {
  page.innerHTML = '<div class="empty">Loading…</div>';
  const [todayRes, overdueRes, editRes, postRes] = await Promise.all([
    Api.get('/api/deliverables?due=today&limit=200'),
    Api.get('/api/deliverables?due=overdue&limit=200'),
    // Content approved + raw video sent by the client → the agency needs to edit.
    Api.get('/api/deliverables?status=raw_uploaded,editing&limit=200'),
    // Client gave final approval → ready to post to social media.
    Api.get('/api/deliverables?status=approved,scheduled&limit=200'),
  ]);
  const overdueIds = new Set(overdueRes.data.map((r) => r.id));
  // One de-duplicated worklist: overdue first, then tasks ready to edit
  // (raw uploaded / editing), then ready to post (approved), then due today.
  const seen = new Set();
  const allRows = [];
  const add = (arr) => arr.forEach((r) => { if (!seen.has(r.id)) { seen.add(r.id); allRows.push(r); } });
  add(overdueRes.data);
  add(editRes.data);
  add(postRes.data);
  add(todayRes.data);

  // Client-side pagination (8 per page) so the list never becomes a long scroll.
  const total = allRows.length;
  const pages = Math.max(1, Math.ceil(total / TODAY_PER_PAGE));
  const pageNo = Math.min(Math.max(1, Number(params.get('page') || 1)), pages);
  const start = (pageNo - 1) * TODAY_PER_PAGE;
  const rows = allRows.slice(start, start + TODAY_PER_PAGE);

  const viewLink = (url) => url
    ? `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener" data-stop>View</a>`
    : '<span class="t-sub">N/A</span>';
  const na = (v) => (v && String(v).trim() ? esc(String(v)) : '<span class="t-sub">N/A</span>');
  const trunc = (v, n = 22) => (v && String(v).trim()
    ? esc(String(v).length > n ? String(v).slice(0, n) + '…' : String(v)) : '<span class="t-sub">N/A</span>');

  const bodyHtml = rows.length ? `
    <table class="tbl today-tbl"><colgroup>
      <col style="width:3%"><col style="width:12%"><col style="width:9%"><col style="width:8%"><col style="width:8%">
      <col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:9%"><col style="width:9%">
      <col style="width:8%"><col style="width:8%"><col style="width:5%"><col style="width:9%"><col style="width:4%">
    </colgroup><thead><tr>
      <th>#</th><th>Client Name</th><th>Creative Type</th><th>Post Schedule Date</th><th>Promotion Type</th>
      <th>Shoot Link</th><th>Editor Link</th><th>Thumbnail</th><th>Caption / Title</th><th>Description / Content</th>
      <th>Content Status</th><th>Editor Status</th><th>Suggestions</th><th>Remarks</th><th>Actions</th>
    </tr></thead><tbody>
    ${rows.map((t, i) => `
      <tr class="clickable ${overdueIds.has(t.id) ? 'row-overdue' : ''}" data-open="${t.id}">
        <td>${start + i + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            ${t.company_logo_url
              ? `<img src="${esc(t.company_logo_url)}" alt="" style="width:24px;height:24px;border-radius:6px;object-fit:cover;flex:0 0 24px">`
              : `<div class="avatar" style="width:24px;height:24px;flex:0 0 24px;font-size:.66rem;border-radius:6px">${esc((t.company_name || 'C')[0])}</div>`}
            <span class="t-main" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.company_name)}">${esc(t.company_name)}</span>
          </div>
        </td>
        <td><span class="badge b-green" style="white-space:nowrap">${esc(t.video_type || t.content_type || label(t.platform))}</span></td>
        <td style="white-space:nowrap;${overdueIds.has(t.id) ? 'color:var(--red);font-weight:700' : ''}">${fmtDate(t.scheduled_at || t.due_date)}</td>
        <td>${t.promotion_type ? `<span class="badge b-blue" style="white-space:nowrap">${esc(t.promotion_type)}</span>` : '<span class="t-sub">N/A</span>'}</td>
        <td>${viewLink(t.raw_drive_link)}</td>
        <td>${viewLink(t.edited_link)}</td>
        <td>${viewLink(t.thumbnail_url)}</td>
        <td>${trunc(t.title, 18)}</td>
        <td>${trunc(t.description || t.caption, 18)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${badge(t.approval_status)}</td>
        <td>${na(t.campaign)}</td>
        <td>${trunc(t.reject_reason, 26)}</td>
        <td class="row-actions"><button class="iconbtn" data-open="${t.id}" title="Update video details" style="color:var(--pink)"><i data-lucide="pencil"></i></button></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">🎉 Nothing to work on right now — nothing due, overdue, or waiting to be edited.</div>';

  const showingTo = Math.min(start + TODAY_PER_PAGE, total);
  const pagerHtml = total ? `
    <div class="pager">
      <span>Items per page: ${TODAY_PER_PAGE} · ${start + 1} – ${showingTo} of ${total}</span>
      <span class="pg-btns">
        <button class="btn btn-outline btn-sm" data-tp="${pageNo - 1}" ${pageNo <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <button class="btn btn-outline btn-sm" data-tp="${pageNo + 1}" ${pageNo >= pages ? 'disabled' : ''}>Next ›</button>
      </span>
    </div>` : '';

  page.innerHTML = `
    <div class="banner">
      <div>Designers — Today's Tasks
        <span style="font-weight:400;opacity:.85;font-size:.82rem">· ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        ${overdueRes.data.length ? `<span class="badge b-red" style="margin-left:8px">${overdueRes.data.length} overdue</span>` : ''}
      </div>
      <div class="head-actions">
        <a class="btn btn-outline btn-sm" href="#/tasks/new" style="background:#fff"><i data-lucide="plus"></i> New Task</a>
        <button class="btn btn-pink btn-sm" id="todayRefresh"><i data-lucide="refresh-cw"></i> Refresh</button>
      </div>
    </div>
    <div class="card"><div class="card-body flush">${bodyHtml}</div>${pagerHtml}</div>`;

  $('#todayRefresh').onclick = () => route();
  $$('[data-stop]').forEach((a) => (a.onclick = (e) => e.stopPropagation()));
  $$('[data-tp]').forEach((b) => (b.onclick = () => nav(`/today?page=${b.dataset.tp}`)));
  // Pen (and row) open the Update Video Details popup.
  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const t = allRows.find((r) => r.id === Number(b.dataset.open));
    if (t) updateVideoModal(t);
  }));
});

/* Update Video Details — popup editor opened from the Today's Tasks pen.
 * Entering a video link or choosing a file auto-generates captions via AI. */
function updateVideoModal(t, opts = {}) {
  // The workflow advances automatically through the approval actions. The only
  // manual step is posting to social media after the client's final approval.
  // Changes requested AFTER the video existed = fix the video; otherwise it's a content fix.
  const videoChanges = t.status === 'changes_requested' && !!t.raw_drive_link;
  // Show the video fields (raw link, thumbnail, video link) on EVERY video task,
  // at every stage. Posters don't use them.
  const isPoster = t.video_type === 'Poster';
  const showVideo = !isPoster;

  // One primary action for the current stage — no manual status dropdown.
  // Awaiting-client / posted states show the button DISABLED so a task can never
  // be accidentally pushed backwards (e.g. an approved task back to review).
  let primary;
  let stageHint = '';
  if (isPoster) {
    // Poster flow: designer designs → ADMIN approves → CLIENT approves → posted.
    if (t.status === 'changes_requested') {
      primary = { label: 'Sent back to designer', disabled: true };
      stageHint = '✏️ Changes requested — waiting for the designer to redo & resubmit the poster.';
    } else if (['pending', 'resolved'].includes(t.status)) {
      primary = { label: 'Waiting for the designer', disabled: true };
      stageHint = '🎨 Assigned to the designer — waiting for them to submit the poster design.';
    } else if (['caption_ready', 'editing', 'raw_uploaded'].includes(t.status)) {
      primary = { label: 'Approve & Send to Client', target: 'review', needsLink: false, posterReview: true };
      stageHint = '🖼️ Designer submitted the poster. Review the design & caption, then approve to send it to the client — or send it back for changes.';
    } else if (t.status === 'review') {
      primary = { label: 'Awaiting Client Approval', disabled: true };
      stageHint = '⏳ Sent to the client — waiting for their approval.';
    } else if (['approved', 'scheduled'].includes(t.status)) {
      primary = { label: 'Mark as Posted', target: 'posted', needsLink: false, confirm: true };
      stageHint = '✅ Client approved the poster. Post it, then mark it posted here.';
    } else {
      primary = { label: 'Posted ✓', disabled: true };
      stageHint = (t.status === 'posted' || t.status === 'completed') ? '🎉 Poster posted.' : `This poster is ${statusLabel(t.status)}.`;
    }
  } else if (t.status === 'changes_requested') {
    if (videoChanges) {
      primary = { label: 'Resend for Final Approval', target: 'review', needsLink: true };
      stageHint = '✏️ Client asked for changes on the VIDEO. Update the video link / captions, then resend for final approval.';
    } else {
      primary = { label: 'Resend for Approval', target: 'content_review', needsLink: false };
      stageHint = '✏️ Client asked for changes on the CONTENT. Update it, then resend for approval.';
    }
  } else if (['pending', 'resolved'].includes(t.status)) {
    primary = { label: 'Send for Approval', target: 'content_review', needsLink: false };
    stageHint = 'Write the content and captions, then send to the client for approval. (No video yet.)';
  } else if (t.status === 'content_review') {
    primary = { label: 'Resend to Client', target: 'content_review', needsLink: false };
    stageHint = '⏳ Waiting for the client to approve the content.';
  } else if (t.status === 'waiting_for_raw') {
    primary = { label: 'Awaiting Raw Video', disabled: true };
    stageHint = '⏳ Content approved — waiting for the client to upload the raw video.';
  } else if (['raw_uploaded', 'editing', 'caption_ready'].includes(t.status)) {
    primary = { label: 'Send for Final Approval', target: 'review', needsLink: true };
    stageHint = 'Raw video is in. Edit it, paste the video link + captions, then send for final approval.';
  } else if (t.status === 'review') {
    primary = { label: 'Awaiting Client Approval', disabled: true };
    stageHint = "⏳ Waiting for the client's final approval.";
  } else if (['approved', 'scheduled'].includes(t.status)) {
    primary = { label: 'Post to Social Media', target: 'posted', needsLink: false, confirm: true };
    stageHint = '✅ Client approved. Post the video on social media, then mark it posted here.';
  } else {
    primary = { label: 'Posted ✓', disabled: true };
    stageHint = (t.status === 'posted' || t.status === 'completed')
      ? '🎉 Posted to social media.' : `This task is ${statusLabel(t.status)}.`;
  }
  const needsLink = !!primary.needsLink;

  const m = modal({
    title: 'Update Content',
    onClose: opts.onClose,
    body: `<form id="uvForm">
      <div style="margin-bottom:6px" class="chip-row">
        <span class="t-sub">${esc(t.company_name || '')} · ${taskCode(t.id)}</span>
        ${statusBadge(t.status)} ${badge(t.approval_status)}
      </div>
      <div class="hint" style="margin-bottom:10px">${stageHint}</div>
      ${t.status === 'changes_requested' && t.reject_reason ? `<div style="margin-bottom:12px;padding:9px 12px;border-radius:8px;background:#fff5f5;border:1px solid #ffc9c9;color:#c92a2a;font-size:.85rem">
        <strong>Client's requested change:</strong> ${esc(t.reject_reason)}</div>` : ''}
      ${F.input('title', 'Title', t.title)}
      ${F.area('content_hook', isPoster ? "What's on the Poster" : "What's in the Video", t.content_hook, { rows: 3, hint: isPoster ? 'The brief the designer works from.' : 'The content the client reviews and approves before filming.' })}
      ${isPoster && t.edited_link ? `<div class="field"><label>Poster design (from the designer)</label>
        <a class="link-btn" href="${esc(t.edited_link)}" target="_blank" rel="noopener">Open poster design ↗</a></div>` : ''}
      <div class="field" data-f="caption">
        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>Caption</span>
          <span style="display:flex;gap:6px">
            <button type="button" class="btn btn-soft btn-sm" id="uvCopyCap"><i data-lucide="copy"></i> Copy</button>
            <button type="button" class="btn btn-soft btn-sm" id="uvGenCap"><i data-lucide="sparkles"></i> Generate</button>
          </span>
        </label>
        <textarea name="caption" rows="7" placeholder="Caption, keywords and hashtags for this content…">${esc(t.caption || '')}</textarea>
        <span class="hint" id="uvCapStatus" style="margin-top:4px">${showVideo ? 'Caption + keywords + hashtags — edit freely.' : 'Write or generate the caption the client will approve.'}</span>
        <div id="uvCapAlts" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>
      ${showVideo ? `
      ${t.raw_drive_link ? `<div class="field"><label>Raw video from client</label>
        <a class="link-btn" href="${esc(t.raw_drive_link)}" target="_blank" rel="noopener">Open raw video ↗</a></div>` : ''}
      <div class="form-row">
        ${F.input('thumbnail_url', 'Thumbnail', t.thumbnail_url, { type: 'url', ph: 'Thumbnail URL' })}
      </div>
      <div class="field" data-f="edited_link"><label>Video Link ${needsLink ? '*' : ''}</label>
        <input name="edited_link" value="${esc(t.edited_link || '')}" placeholder="https://drive.google.com/…">
        <span class="hint" style="margin-top:4px">Adding a video link can auto-generate the captions above.</span>
      </div>` : ''}

      <div style="margin-top:14px">
        <button type="button" class="btn btn-ghost btn-sm" id="uvDelete" style="color:var(--red)"><i data-lucide="trash-2"></i> Delete task</button>
      </div>
    </form>`,
    footer: `<button class="btn btn-danger" data-x>Cancel</button>
             <button class="btn btn-outline" data-draft>Save Draft</button>
             ${primary.posterReview ? '<button class="btn btn-soft" data-sendback style="color:var(--red)">Send Back</button>' : ''}
             <button class="btn btn-primary" data-approve ${primary.disabled ? 'disabled' : ''}>${primary.label}</button>`,
  });
  icons();

  const capEl = $('#uvForm [name=caption]', m.el);
  const linkEl = $('#uvForm [name=edited_link]', m.el);
  const capStatus = $('#uvCapStatus', m.el);
  const capAlts = $('#uvCapAlts', m.el);
  const origLink = t.edited_link || '';
  const STYLE_LABELS = ['Professional', 'Emotional', 'Engagement', 'Short', 'Sales'];

  const copyCap = $('#uvCopyCap', m.el);
  if (copyCap) copyCap.onclick = () => {
    if (!capEl.value.trim()) return toastErr('Nothing to copy yet');
    navigator.clipboard.writeText(capEl.value).then(() => toastOk('Caption copied'));
  };

  const genCaptions = async () => {
    capStatus.textContent = '✨ Generating captions…';
    if (capAlts) capAlts.innerHTML = '';
    try {
      const res = await Api.post(`/api/ai/caption/${t.id}`);
      const g = res.data;
      if (g.caption) capEl.value = g.caption;
      capStatus.innerHTML = `<span style="color:var(--green)">✓ ${g.provider && g.provider !== 'heuristic' ? 'AI' : 'Draft'} captions ready${g.industry ? ' · ' + esc(g.industry) : ''}</span>`
        + (g.heuristic_note ? ` <span style="color:var(--amber)">· ${esc(g.heuristic_note)}</span>` : '');
      // Styled alternates → click to rebuild the caption with that style body.
      if (capAlts && Array.isArray(g.alternate_captions) && g.alternate_captions.length) {
        capAlts.innerHTML = '<span class="hint" style="width:100%;margin:0">Try another style:</span>'
          + g.alternate_captions.map((_, i) =>
            `<button type="button" class="btn btn-soft btn-sm" data-alt="${i}">${STYLE_LABELS[i] || 'Option ' + (i + 1)}</button>`).join('');
        const DIV = '-----------------------------------';
        const below = g.sections_below || '';
        capAlts.querySelectorAll('[data-alt]').forEach((b) => (b.onclick = () => {
          const altBody = g.alternate_captions[Number(b.dataset.alt)];
          capEl.value = [altBody, below].filter(Boolean).join(`\n\n${DIV}\n\n`);
        }));
      }
      toastOk('Captions generated');
    } catch (ex) { capStatus.textContent = ''; toastErr(ex.message); }
  };
  $('#uvGenCap', m.el).onclick = genCaptions;
  // Auto-generate when a new video link is entered (only shown in the video stage).
  if (linkEl) linkEl.onblur = () => {
    const v = linkEl.value.trim();
    if (v && v !== origLink && /^https?:\/\//i.test(v)) genCaptions();
  };

  const collect = () => {
    const fd = new FormData($('#uvForm', m.el));
    const body = {};
    ['title', 'thumbnail_url', 'content_hook', 'caption', 'edited_link']
      .forEach((k) => { const v = fd.get(k); if (v !== null) body[k] = String(v).trim(); });
    return body;
  };

  // After a save: if the modal has its own onClose (route-opened popup) let that
  // handle navigation; otherwise close + refresh the current list.
  const afterSave = () => { m.close(); if (!opts.onClose) (opts.afterSave || (() => route()))(); };

  // The final-approval action needs the edited video link; others don't.
  const approveBtn = $('[data-approve]', m.foot);
  const syncApprove = () => {
    if (!approveBtn) return;
    if (primary.disabled) { approveBtn.disabled = true; return; }
    if (!needsLink) { approveBtn.disabled = false; approveBtn.title = ''; return; }
    const has = !!(linkEl && linkEl.value.trim());
    approveBtn.disabled = !has;
    approveBtn.title = has ? '' : 'Add the edited video / drive link first';
  };
  if (linkEl) linkEl.addEventListener('input', syncApprove);
  syncApprove();

  $('#uvDelete', m.el).onclick = () => confirmModal('Delete task', `Delete "${t.title}" permanently? All versions, comments and history go with it.`, async () => {
    try { await Api.del(`/api/deliverables/${t.id}`); toastOk('Task deleted'); afterSave(); }
    catch (ex) { toastErr(ex.message); }
  });

  $('[data-x]', m.foot).onclick = m.close;
  $('[data-draft]', m.foot).onclick = async () => {
    try { await Api.patch(`/api/deliverables/${t.id}`, collect()); toastOk('Draft saved'); afterSave(); }
    catch (ex) { toastErr(errText(ex)); }
  };
  if (approveBtn && !primary.disabled && primary.target) approveBtn.onclick = async () => {
    if (primary.needsLink && (!linkEl || !linkEl.value.trim())) {
      toastErr('Add the edited video / drive link first'); if (linkEl) linkEl.focus(); return;
    }
    const run = async () => {
      try {
        await Api.patch(`/api/deliverables/${t.id}`, collect());
        await Api.post(`/api/deliverables/${t.id}/status`, { status: primary.target });
        toastOk(
          primary.target === 'posted' ? (isPoster ? 'Poster marked as posted' : 'Marked as posted to social media')
            : primary.target === 'content_review' ? 'Content sent to client for approval'
              : isPoster ? 'Approved — sent to the client for approval'
                : 'Sent for final client approval');
        afterSave();
      } catch (ex) { toastErr(ex.message); }
    };
    if (primary.confirm) confirmModal(isPoster ? 'Post the poster' : 'Post to social media', `Mark "${t.title}" as posted?`, run);
    else run();
  };

  // Poster: send the design back to the designer with a change note.
  const sendBackBtn = $('[data-sendback]', m.foot);
  if (sendBackBtn) sendBackBtn.onclick = () => {
    const rm = modal({
      title: 'Send back to designer',
      body: `<div class="field"><label>What should the designer change?</label>
        <textarea id="sbReason" rows="4" placeholder="Describe the changes needed on the poster…"></textarea></div>`,
      footer: '<button class="btn btn-danger" data-x>Cancel</button><button class="btn btn-primary" data-y>Send Back</button>',
    });
    $('[data-x]', rm.foot).onclick = rm.close;
    $('[data-y]', rm.foot).onclick = async () => {
      const reason = $('#sbReason', rm.el).value.trim();
      if (reason.length < 3) return toastErr('Please describe the change needed');
      try {
        await Api.patch(`/api/deliverables/${t.id}`, collect());
        await Api.post(`/api/deliverables/${t.id}/status`, { status: 'changes_requested', reason });
        toastOk('Sent back to the designer');
        rm.close(); afterSave();
      } catch (ex) { toastErr(ex.message); }
    };
  };
}

/* #/tasks/:id — the task editor is now the content+captions popup, shown over
 * the Content list. #/tasks/:id/full still opens the complete workspace. */
ERP.register('task', async function renderTaskPopup(id) {
  const r = await Api.get(`/api/deliverables/${id}`);
  await ERP.routes.content(new URLSearchParams());
  updateVideoModal(r.data, { onClose: () => nav('/content'), afterSave: () => nav('/content') });
});

/* ============ CONTENT (deliverables list) ============ */
ERP.register('content', async function renderContent(params) {
  const pageNo = Number(params.get('page') || 1);
  const filters = ['client_id', 'status', 'platform', 'month', 'due', 'approval', 'q'];
  const qs = new URLSearchParams({ page: pageNo, limit: 20 });
  filters.forEach((f) => { if (params.get(f)) qs.set(f, params.get(f)); });
  qs.set('not_video_type', 'Poster'); // Videos view excludes posters

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Content</h1><div class="sub">Plan, produce and deliver every content item</div></div>
      <div class="head-actions"><a class="btn btn-primary" href="#/tasks/new"><i data-lucide="plus"></i> New Task</a></div>
    </div>
    <div class="filters">
      <select id="fClient">${await clientOptionsHtml(params.get('client_id'))}</select>
      <select id="fStatus"><option value="">All statuses</option>
        ${STATUSES.map((s) => `<option value="${s}" ${params.get('status') === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}</select>
      <select id="fPlatform"><option value="">All platforms</option>${platformOptions(params.get('platform'))}</select>
      <input type="month" id="fMonth" value="${esc(params.get('month') || '')}" />
      <select id="fDue"><option value="">Any due date</option>
        ${['today', 'upcoming', 'overdue'].map((x) => `<option value="${x}" ${params.get('due') === x ? 'selected' : ''}>${label(x)}</option>`).join('')}</select>
      <input type="search" id="fQ" placeholder="Search title/caption…" value="${esc(params.get('q') || '')}" />
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="delivTable"></div><div class="pager" id="delivPager"></div></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    if ($('#fClient').value) p.set('client_id', $('#fClient').value);
    if ($('#fStatus').value) p.set('status', $('#fStatus').value);
    if ($('#fPlatform').value) p.set('platform', $('#fPlatform').value);
    if ($('#fMonth').value) p.set('month', $('#fMonth').value);
    if ($('#fDue').value) p.set('due', $('#fDue').value);
    if ($('#fQ').value) p.set('q', $('#fQ').value);
    nav(`/content?${p}`);
  };
  ['fClient', 'fStatus', 'fPlatform', 'fMonth', 'fDue'].forEach((id) => ($(`#${id}`).onchange = apply));
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };

  const r = await Api.get(`/api/deliverables?${qs}`);
  $('#delivTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr>
      <th>Task</th><th>Client</th><th>Platform</th><th>Due</th><th>Priority</th><th>Status</th><th>Approval</th><th>AI</th><th></th>
    </tr></thead><tbody>
    ${r.data.map((d) => {
      const overdue = d.due_date && d.due_date.slice(0, 10) < todayStr() &&
        !['posted', 'completed', 'cancelled', 'rejected'].includes(d.status);
      return `<tr class="clickable" data-open="${d.id}">
        <td><div class="t-main">${esc(d.title)}</div><div class="t-sub">${taskCode(d.id)}</div></td>
        <td>${esc(d.company_name)}</td>
        <td><span class="badge b-primary">${label(d.platform)}</span></td>
        <td style="${overdue ? 'color:var(--red);font-weight:700' : ''}">${fmtDate(d.due_date)}</td>
        <td>${badge(d.priority)}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${badge(d.approval_status)}</td>
        <td>${d.ai_score ? `<strong style="color:${scoreColor(d.ai_score)}">${d.ai_score}</strong>` : '—'}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-open="${d.id}" title="Edit content & captions"><i data-lucide="pen-line"></i></button></td>
      </tr>`;
    }).join('')}
    </tbody></table>` : '<div class="empty">No content matches these filters.</div>';

  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const d = r.data.find((x) => x.id === Number(b.dataset.open));
    if (d) updateVideoModal(d);
  }));
  pager($('#delivPager'), r.pagination, (p) => { qs.set('page', p); nav(`/content?${qs}`); });
});

/* ============ APPROVALS ============ */
ERP.register('approvals', async function renderApprovals(params) {
  const tab = params.get('tab') || 'content';
  const tabs = [
    ['content', 'Content review (Gate 1)', 'status=content_review'],
    ['final', 'Final review (Gate 2)', 'status=review'],
    ['changes', 'Changes requested', 'status=changes_requested'],
    ['approved', 'Recently approved', 'approval=approved'],
  ];
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Approvals</h1><div class="sub">Everything moving through client review</div></div>
    </div>
    <div class="tabs" style="border-bottom:1px solid var(--line);margin-bottom:16px">
      ${tabs.map(([k, lbl]) => `<button class="tab ${tab === k ? 'active' : ''}" data-tab="${k}">${lbl}</button>`).join('')}
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="apprTable"></div><div class="pager" id="apprPager"></div></div>`;

  $$('.tab[data-tab]').forEach((b) => (b.onclick = () => nav(`/approvals?tab=${b.dataset.tab}`)));

  const qs = new URLSearchParams(tabs.find(([k]) => k === tab)[2]);
  qs.set('limit', 20);
  qs.set('page', params.get('page') || 1);
  const r = await Api.get(`/api/deliverables?${qs}`);

  $('#apprTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr>
      <th>Task</th><th>Client</th><th>Platform</th><th>Due</th><th>Status</th><th>Client note / change</th><th></th>
    </tr></thead><tbody>
    ${r.data.map((d) => `
      <tr class="clickable" data-nav="/tasks/${d.id}">
        <td><div class="t-main">${esc(d.title)}</div><div class="t-sub">${taskCode(d.id)}</div></td>
        <td>${esc(d.company_name)}</td>
        <td><span class="badge b-primary">${label(d.platform)}</span></td>
        <td>${fmtDate(d.due_date)}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${d.reject_reason ? `<span style="color:var(--red)">${esc(d.reject_reason)}</span>` : '<span class="t-sub">—</span>'}</td>
        <td class="row-actions"><span class="link-btn">Open →</span></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">Nothing here right now.</div>';

  pager($('#apprPager'), r.pagination, (p) => nav(`/approvals?tab=${tab}&page=${p}`));
});

/* ============ CLIENT REPORT — monthly scorecard ============ */
function pctBar(approved, total) {
  const pct = total ? Math.round((approved / total) * 100) : 0;
  const color = pct >= 80 ? 'var(--primary)' : pct >= 50 ? '#e8590c' : '#e03131';
  return `<div style="display:flex;align-items:center;gap:8px;min-width:120px">
    <div style="flex:1;height:6px;background:#f1f3f5;border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color}"></div></div>
    <span style="font-size:.78rem;min-width:42px;text-align:right;font-weight:600">${pct}%</span></div>`;
}
const monthShift = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1 + n, 1).toLocaleDateString('en-CA').slice(0, 7);
};

ERP.register('client-report', async function renderClientReport(params) {
  const month = params.get('month') || thisMonth();
  page.innerHTML = `
    <div class="banner"><div>Clients List · Monthly Scorecard</div>
      <div class="head-actions">
        <button class="btn btn-outline btn-sm" id="crPrev" style="background:#fff"><i data-lucide="chevron-left"></i></button>
        <input type="month" id="crMonth" value="${month}" style="border:0;border-radius:8px;padding:6px 10px;font-weight:600">
        <button class="btn btn-outline btn-sm" id="crNext" style="background:#fff"><i data-lucide="chevron-right"></i></button>
      </div>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="crTable"><div class="empty">Loading…</div></div></div>`;
  $('#crPrev').onclick = () => nav(`/client-report?month=${monthShift(month, -1)}`);
  $('#crNext').onclick = () => nav(`/client-report?month=${monthShift(month, 1)}`);
  $('#crMonth').onchange = () => nav(`/client-report?month=${$('#crMonth').value}`);

  const r = await Api.get(`/api/clients/scorecard?month=${month}`);
  $('#crTable').innerHTML = r.data.clients.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Name of the Client</th>
      <th>YouTube Videos</th><th>Approved</th><th>% Approved</th>
      <th>Educational Reels</th><th>Approved</th><th>% Approved</th><th></th>
    </tr></thead><tbody>
    ${r.data.clients.map((c, i) => `
      <tr class="clickable" data-nav="/client-report/${c.id}?month=${month}">
        <td>${i + 1}</td>
        <td class="t-main">${esc(c.company_name)}</td>
        <td>${c.yt_total}</td><td>${c.yt_approved}</td><td>${pctBar(Number(c.yt_approved), Number(c.yt_total))}</td>
        <td>${c.reel_total}</td><td>${c.reel_approved}</td><td>${pctBar(Number(c.reel_approved), Number(c.reel_total))}</td>
        <td class="row-actions"><span class="link-btn">Open →</span></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No clients for this month.</div>';
});

/* ============ CLIENT REPORT — individual client month view ============ */
ERP.register('client-report-detail', async function renderClientReportDetail(id, params) {
  const month = params.get('month') || thisMonth();
  page.innerHTML = '<div class="empty">Loading…</div>';
  const [clientRes, delivRes] = await Promise.all([
    Api.get(`/api/clients/${id}`),
    Api.get(`/api/deliverables?client_id=${id}&month=${month}&limit=200`),
  ]);
  const client = clientRes.data;
  const rows = delivRes.data;
  const ytCount = rows.filter((d) => ['youtube_short', 'youtube_long'].includes(d.platform)).length;
  const reelCount = rows.filter((d) => d.platform === 'instagram_reel').length;

  const viewLink = (url) => url
    ? `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener" data-stop>View</a>` : '<span class="t-sub">N/A</span>';
  const trunc = (v, n = 26) => (v && String(v).trim()
    ? esc(String(v).length > n ? String(v).slice(0, n) + '…' : String(v)) : '<span class="t-sub">N/A</span>');
  const editorStatus = (d) => {
    if (['posted', 'completed', 'approved', 'scheduled'].includes(d.status)) return '<span class="badge b-green">Done</span>';
    if (d.status === 'changes_requested') return '<span class="badge b-red">Changes</span>';
    if (['content_review', 'review'].includes(d.status)) return '<span class="badge b-violet">Sent for Approval</span>';
    if (['caption_ready', 'editing', 'raw_uploaded'].includes(d.status)) return '<span class="badge b-blue">In Progress</span>';
    return '<span class="badge b-amber">Yet To Start</span>';
  };

  page.innerHTML = `
    <div class="banner">
      <div><a class="link-btn" href="#/client-report?month=${month}" style="color:#fff">← Clients</a> · ${esc(client.company_name)}</div>
      <div class="head-actions">
        <button class="btn btn-outline btn-sm" id="cdPrev" style="background:#fff"><i data-lucide="chevron-left"></i></button>
        <input type="month" id="cdMonth" value="${month}" style="border:0;border-radius:8px;padding:6px 10px;font-weight:600">
        <button class="btn btn-outline btn-sm" id="cdNext" style="background:#fff"><i data-lucide="chevron-right"></i></button>
      </div>
    </div>
    <div class="chip-row" style="margin-bottom:14px">
      <span class="badge b-amber" style="font-size:.85rem;padding:8px 14px">▶ YouTube Videos: ${ytCount}</span>
      <span class="badge b-violet" style="font-size:.85rem;padding:8px 14px">🎓 Educational Reels: ${reelCount}</span>
      <span class="badge b-blue" style="font-size:.85rem;padding:8px 14px">🎬 Total Videos: ${rows.length}</span>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="cdTable"></div></div>`;

  $('#cdPrev').onclick = () => nav(`/client-report/${id}?month=${monthShift(month, -1)}`);
  $('#cdNext').onclick = () => nav(`/client-report/${id}?month=${monthShift(month, 1)}`);
  $('#cdMonth').onchange = () => nav(`/client-report/${id}?month=${$('#cdMonth').value}`);

  $('#cdTable').innerHTML = rows.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Creative Type</th><th>Post Date</th><th>Promotion</th><th>Shoot</th><th>Editor</th><th>Thumbnail</th>
      <th>Title</th><th>Description</th><th>Content Status</th><th>Editor Status</th><th>Remarks</th><th></th>
    </tr></thead><tbody>
    ${rows.map((d, i) => `
      <tr class="clickable" data-open="${d.id}">
        <td>${i + 1}</td>
        <td><span class="badge b-green">${esc(d.video_type || label(d.platform))}</span></td>
        <td style="white-space:nowrap">${fmtDate(d.scheduled_at || d.due_date)}</td>
        <td>${d.promotion_type ? `<span class="badge b-blue">${esc(d.promotion_type)}</span>` : '<span class="t-sub">N/A</span>'}</td>
        <td>${viewLink(d.raw_drive_link)}</td>
        <td>${viewLink(d.edited_link)}</td>
        <td>${viewLink(d.thumbnail_url)}</td>
        <td>${trunc(d.title, 30)}</td>
        <td>${trunc(d.caption || d.description, 22)}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${editorStatus(d)}</td>
        <td>${trunc(d.reject_reason, 18)}</td>
        <td class="row-actions"><button class="iconbtn" data-open="${d.id}" title="Edit" style="color:var(--pink)"><i data-lucide="pencil"></i></button></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No content for this client in this month.</div>';

  $$('[data-stop]').forEach((a) => (a.onclick = (e) => e.stopPropagation()));
  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const d = rows.find((x) => x.id === Number(b.dataset.open));
    if (d) updateVideoModal(d, { afterSave: () => route() });
  }));
  icons(); // this page is reached via a direct route, so render icons here too
});

/* ============ POSTERS (admin) — separate from videos ============ */
ERP.register('posters', async function renderPosters() {
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Posters</h1><div class="sub">Poster designs — assign to a poster designer</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="newPoster"><i data-lucide="plus"></i> New Poster</button></div>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="postersTable"><div class="empty">Loading…</div></div></div>`;
  $('#newPoster').onclick = () => newPosterModal();
  const [r, team] = await Promise.all([
    Api.get('/api/deliverables?video_type=Poster&limit=200'),
    getTeam().catch(() => []),
  ]);
  const rows = r.data;
  const nameOf = (uid) => { const u = team.find((x) => String(x.id) === String(uid)); return u ? u.name : '—'; };
  $('#postersTable').innerHTML = rows.length ? `
    <table class="tbl"><thead><tr>
      <th>#</th><th>Client</th><th>Title</th><th>Brief</th><th>Assigned to</th><th>Design</th><th>Due</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${rows.map((d, i) => `
      <tr class="clickable" data-open="${d.id}">
        <td>${i + 1}</td>
        <td class="t-main">${esc(d.company_name || '')}</td>
        <td>${esc(d.title)}</td>
        <td>${d.content_hook ? esc(String(d.content_hook).slice(0, 32)) + '…' : '<span class="t-sub">—</span>'}</td>
        <td>${d.assigned_to ? esc(nameOf(d.assigned_to)) : '<span class="t-sub">Unassigned</span>'}</td>
        <td>${d.edited_link ? `<a class="link-btn" href="${esc(d.edited_link)}" target="_blank" rel="noopener" data-stop>View</a>` : '<span class="t-sub">—</span>'}</td>
        <td style="white-space:nowrap">${fmtDate(d.due_date)}</td>
        <td>${statusBadge(d.status)}</td>
        <td class="row-actions"><button class="iconbtn" data-open="${d.id}" title="Edit" style="color:var(--pink)"><i data-lucide="pencil"></i></button></td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No posters yet. Click “New Poster” to create one.</div>';
  $$('[data-stop]').forEach((a) => (a.onclick = (e) => e.stopPropagation()));
  $$('[data-open]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const d = rows.find((x) => x.id === Number(b.dataset.open));
    if (d) updateVideoModal(d, { afterSave: () => nav('/posters') });
  }));
  icons();
});

function newPosterModal() {
  const m = modal({
    title: 'New Poster',
    body: `<form id="npForm">
      <div class="field"><label>Client *</label><select name="client_id" id="npClient"><option value="">Loading…</option></select></div>
      ${F.input('title', 'Poster title', '', { ph: 'e.g. Diwali Offer Poster' })}
      ${F.area('content_hook', 'Poster brief (what to design)', '', { rows: 3, hint: 'Auto-assigned to the client\'s designer.' })}
      <div class="field"><label>Due date</label><input type="date" name="due_date"></div>
    </form>`,
    footer: `<button class="btn btn-outline" data-x>Cancel</button>
             <button class="btn btn-primary" data-y>Create Poster</button>`,
  });
  (async () => {
    const cs = $('#npClient', m.el);
    cs.innerHTML = '<option value="">Select client…</option>'
      + (await getClients()).map((c) => `<option value="${c.id}">${esc(c.company_name)}</option>`).join('');
  })();
  $('[data-x]', m.foot).onclick = m.close;
  $('[data-y]', m.foot).onclick = async () => {
    const fd = new FormData($('#npForm', m.el));
    const clientId = fd.get('client_id');
    const title = String(fd.get('title') || '').trim();
    if (!clientId) return toastErr('Pick a client');
    if (title.length < 2) return toastErr('Enter a poster title');
    try {
      const res = await Api.post('/api/deliverables', {
        client_id: Number(clientId), title, platform: 'poster', content_type: 'poster',
        due_date: fd.get('due_date') || undefined,
      });
      const id = res.data.ids[0];
      const patch = { video_type: 'Poster' };
      const brief = String(fd.get('content_hook') || '').trim();
      if (brief) patch.content_hook = brief;
      await Api.patch(`/api/deliverables/${id}`, patch);
      toastOk('Poster created');
      m.close();
      nav('/posters');
    } catch (ex) { toastErr(errText(ex)); }
  };
}

/* ============ CALENDAR ============ */
ERP.register('calendar', async function renderCalendar(params) {
  const view = params.get('view') === 'week' ? 'week' : 'month';
  const clientId = params.get('client_id') || '';
  const month = params.get('month') || thisMonth();
  const refDate = params.get('date') || todayStr();

  const dayModal = (date, items) => modal({
    title: `Tasks — ${fmtDate(date)}`,
    body: items.length ? items.map((it) => `
      <div class="notif-item" style="cursor:pointer" data-nav="/tasks/${it.id}">
        <div class="n-title">${esc(it.title)} ${statusBadge(it.status)}</div>
        <div class="n-body">${esc(it.company_name)} · ${label(it.platform)}</div>
      </div>`).join('') : '<div class="empty">No tasks on this date</div>',
    footer: null,
  });

  const buildHash = (over = {}) => {
    const p = new URLSearchParams({ view, ...(view === 'week' ? { date: refDate } : { month }), ...over });
    if (clientId) p.set('client_id', clientId);
    return `/calendar?${p}`;
  };

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Calendar</h1><div class="sub">Date-wise content planning with colour-coded statuses</div></div>
      <div class="head-actions">
        <div class="cal-toggle">
          <button id="viewMonth" class="${view === 'month' ? 'active' : ''}">Month</button>
          <button id="viewWeek" class="${view === 'week' ? 'active' : ''}">Week</button>
        </div>
        <select id="calClient" style="padding:8px 11px;border:1px solid var(--line);border-radius:9px">${await clientOptionsHtml(clientId)}</select>
      </div>
    </div>
    <div class="card"><div class="card-body"><div id="bigCal"></div></div></div>
    <div style="margin-top:10px" class="chip-row">
      <span class="badge b-green">Completed / Posted / Approved</span>
      <span class="badge b-blue">Scheduled / Raw uploaded</span>
      <span class="badge b-amber">Review / Waiting</span>
      <span class="badge b-violet">Editing / Caption ready</span>
      <span class="badge b-red">Changes / Rejected</span>
    </div>`;

  $('#viewMonth').onclick = () => nav(buildHash({ view: 'month', month: refDate.slice(0, 7) }));
  $('#viewWeek').onclick = () => nav(buildHash({ view: 'week', date: `${month}-15` }));
  $('#calClient').onchange = () => {
    const p = new URLSearchParams(window.location.hash.split('?')[1] || '');
    if ($('#calClient').value) p.set('client_id', $('#calClient').value); else p.delete('client_id');
    nav(`/calendar?${p}`);
  };

  const monthsNeeded = new Set();
  if (view === 'month') {
    monthsNeeded.add(month);
  } else {
    const ref = new Date(`${refDate}T00:00:00`);
    const start = new Date(ref); start.setDate(ref.getDate() - ref.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 6);
    monthsNeeded.add(start.toLocaleDateString('en-CA').slice(0, 7));
    monthsNeeded.add(end.toLocaleDateString('en-CA').slice(0, 7));
  }
  const results = await Promise.all([...monthsNeeded].map((mk) => {
    const q = new URLSearchParams({ month: mk });
    if (clientId) q.set('client_id', clientId);
    return Api.get(`/api/deliverables/calendar?${q}`);
  }));
  const items = results.flatMap((x) => x.data.items);

  if (view === 'week') {
    calendarWeek($('#bigCal'), refDate, items, {
      onNav: (nextDate) => nav(buildHash({ date: nextDate })),
      onDayClick: dayModal,
    });
  } else {
    calendar($('#bigCal'), month, items, {
      onNav: (next) => nav(buildHash({ month: next })),
      onDayClick: dayModal,
    });
    if (params.get('date')) {
      const dayItems = items.filter((i) => String(i.due_date).slice(0, 10) === params.get('date'));
      if (dayItems.length) $(`.cal-cell[data-date="${params.get('date')}"]`)?.click();
    }
  }
});

/* ============ CLIENTS (list) ============ */
ERP.register('clients', async function renderClients(params) {
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const pageNo = Number(params.get('page') || 1);

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Clients</h1><div class="sub">Manage agency clients and their portal access</div></div>
      <div class="head-actions"><a class="btn btn-primary" href="#/clients/new"><i data-lucide="plus"></i> Add Client</a></div>
    </div>
    <div class="filters">
      <input type="search" id="fQ" placeholder="Search clients…" value="${esc(q)}" />
      <select id="fStatus">
        <option value="">All statuses</option>
        ${['active', 'inactive', 'paused', 'churned'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${label(s)}</option>`).join('')}
      </select>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="clientTable"></div><div class="pager" id="clientPager"></div></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    if ($('#fQ').value) p.set('q', $('#fQ').value);
    if ($('#fStatus').value) p.set('status', $('#fStatus').value);
    nav(`/clients?${p}`);
  };
  $('#fStatus').onchange = apply;
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };

  const qs = new URLSearchParams({ page: pageNo, limit: 15 });
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  const r = await Api.get(`/api/clients?${qs}`);

  $('#clientTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr>
      <th>Company</th><th>Contact</th><th>Package</th><th>Renewal</th><th>Month Progress</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${r.data.map((c) => `
      <tr class="clickable" data-nav="/clients/${c.id}">
        <td><div class="t-main">${esc(c.company_name)}</div><div class="t-sub">${esc(c.business_type || '')}</div></td>
        <td><div>${esc(c.contact_person || '—')}</div><div class="t-sub">${esc(c.email || '')} ${esc(c.phone || '')}</div></td>
        <td><div>${esc(c.monthly_package || '—')}</div><div class="t-sub">${fmtMoney(c.package_amount)}/${esc((c.payment_plan || 'monthly').replace('_', ' '))}</div></td>
        <td>${fmtDate(c.renewal_date)}</td>
        <td style="min-width:130px">
          <div class="t-sub" style="margin-bottom:3px">${c.month_done}/${c.month_total || 0} done</div>
          <div class="progress"><div style="width:${c.month_total ? Math.round((c.month_done / c.month_total) * 100) : 0}%"></div></div>
        </td>
        <td>${badge(c.status)}</td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm" data-edit="${c.id}">Open</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del="${c.id}">Archive</button>
        </td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">No clients found. Add your first client to get started.</div>';

  pager($('#clientPager'), r.pagination, (p) => {
    const np = new URLSearchParams(window.location.hash.split('?')[1] || '');
    np.set('page', p);
    nav(`/clients?${np}`);
  });

  $$('[data-edit]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); nav(`/clients/${b.dataset.edit}`); }));
  $$('[data-del]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const c = r.data.find((x) => x.id === Number(b.dataset.del));
    confirmModal('Archive client', `Archive "${c.company_name}"? Their portal login will be disabled.`, async () => {
      await Api.del(`/api/clients/${c.id}`);
      invalidateClients();
      toastOk('Client archived');
      route();
    });
  }));
});

/* ============ CLIENT EDITOR (full page — replaces the old modal) ============ */
ERP.register('client-form', async function renderClientForm(id) {
  page.innerHTML = '<div class="empty">Loading…</div>';
  let c = null;
  let cfg = null;
  let def = null;
  if (id) {
    const [cRes, cfgRes, defRes] = await Promise.all([
      Api.get(`/api/clients/${id}`),
      Api.get(`/api/clients/${id}/caption-config`).catch(() => ({ data: {} })),
      Api.get('/api/ai/caption-defaults').catch(() => ({ data: {} })),
    ]);
    c = cRes.data;
    cfg = cfgRes.data || {};
    def = defRes.data || {};
  }
  const s = { ...(def?.default_settings || {}), ...((cfg && cfg.caption_settings) || {}) };
  const ph = (cfg && cfg.placeholder_values) || {};
  const tpl = (cfg && cfg.caption_template) || def?.default_template || '';
  const designers = (await getTeam().catch(() => [])).filter((u) => u.role === 'poster_designer');
  const designerOpts = '<option value="">— None —</option>'
    + designers.map((u) => `<option value="${u.id}" ${String(c?.designer_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');

  page.innerHTML = `
    <div class="page-head">
      <div>
        <a class="link-btn" href="#/clients">← Back to clients</a>
        <h1 style="margin-top:4px">${c ? esc(c.company_name) : 'Add Client'}</h1>
        <div class="sub">${c ? 'Update client profile, package, portal access and Caption AI' : 'Create a new client profile'}</div>
      </div>
      <div class="head-actions">
        <a class="btn btn-outline" href="#/clients">Cancel</a>
        <button class="btn btn-primary" id="saveClient"><i data-lucide="save"></i> ${c ? 'Save Changes' : 'Create Client'}</button>
      </div>
    </div>

    <form id="clientForm" class="grid grid-2" style="align-items:start">
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="card"><div class="card-head"><h3>Company</h3></div><div class="card-body">
          ${F.input('company_name', 'Company name *', c?.company_name, { extra: 'required' })}
          <div class="form-row">
            ${F.input('contact_person', 'Contact person', c?.contact_person)}
            ${F.input('business_type', 'Business category', c?.business_type)}
          </div>
          <div class="form-row">
            ${F.input('email', 'Email', c?.email, { type: 'email' })}
            ${F.input('phone', 'Phone', c?.phone)}
          </div>
          ${F.input('website', 'Website', c?.website, { type: 'url' })}
          <div class="form-row">
            ${F.input('company_logo_url', 'Company logo URL', c?.company_logo_url, { type: 'url' })}
            ${F.input('footer_watermark_url', 'Footer / watermark URL', c?.footer_watermark_url, { type: 'url' })}
          </div>
          ${F.area('notes', 'Notes', c?.notes, { rows: 3 })}
        </div></div>

        <div class="card"><div class="card-head"><h3>Social & analytics</h3></div><div class="card-body">
          <div class="form-row">
            ${F.input('instagram_link', 'Instagram link', c?.instagram_link, { type: 'url' })}
            ${F.input('facebook_link', 'Facebook link', c?.facebook_link, { type: 'url' })}
          </div>
          ${F.input('youtube_link', 'YouTube link', c?.youtube_link, { type: 'url' })}
          <div class="form-row">
            ${F.input('ig_user_id', 'Instagram business ID', c?.ig_user_id, { hint: 'Used by Meta Graph analytics' })}
            ${F.input('youtube_channel_id', 'YouTube channel ID', c?.youtube_channel_id, { hint: 'Used by YouTube analytics' })}
          </div>
        </div></div>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="card"><div class="card-head"><h3>Package & billing</h3></div><div class="card-body">
          <div class="form-row">
            ${F.input('monthly_package', 'Package name', c?.monthly_package)}
            ${F.input('package_amount', 'Package amount (₹)', c?.package_amount, { type: 'number', extra: 'min="0" step="0.01"' })}
          </div>
          <div class="form-row">
            ${F.select('payment_plan', 'Payment plan', selectOptions(['monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time'], c?.payment_plan || 'monthly'))}
            ${F.input('monthly_deliverables', 'Monthly content target', c?.monthly_deliverables ?? '', { type: 'number', extra: 'min="0"' })}
          </div>
          <div class="form-row">
            ${F.input('joining_date', 'Joining date', (c?.joining_date || '').slice(0, 10), { type: 'date' })}
            ${F.input('renewal_date', 'Renewal date', (c?.renewal_date || '').slice(0, 10), { type: 'date' })}
          </div>
          <div class="form-row">
            ${F.select('status', 'Status', selectOptions(['active', 'inactive', 'paused', 'churned'], c?.status || 'active'))}
            ${F.select('designer_id', 'Assigned designer', designerOpts, { hint: 'All this client\'s tasks go to this designer' })}
          </div>
        </div></div>

        <div class="card"><div class="card-head"><h3>Portal access</h3></div><div class="card-body">
          ${c?.login_email
            ? `<div class="kv"><span class="k">Login email</span><span class="v">${esc(c.login_email)}</span></div>`
            : '<div class="hint" style="margin-bottom:10px">No portal login yet. Set the email above and a password below to create one.</div>'}
          ${F.input('portal_password', c ? 'Reset portal password' : 'Portal password (optional)', '', {
            ph: 'Min 8 chars, letters + numbers',
            hint: 'The client signs in to the portal with their email + this password. Leave blank to keep unchanged.',
          })}
        </div></div>

        ${c ? `
        <div class="card"><div class="card-head"><h3>Caption AI</h3><span class="badge b-violet">per-client</span></div><div class="card-body">
          <div class="form-row">
            ${F.input('s_language', 'Preferred language', s.language, { ph: 'e.g. English, Hindi, Tenglish' })}
            ${F.input('s_tone', 'Tone', s.tone, { ph: 'e.g. friendly, bold, luxury' })}
          </div>
          <div class="form-row">
            ${F.select('s_length', 'Length', selectOptions(['short', 'medium', 'long'], s.length || 'medium'))}
            ${F.select('s_emoji_style', 'Emoji style', selectOptions(['none', 'minimal', 'moderate', 'lots'], s.emoji_style || 'minimal'))}
          </div>
          ${F.input('s_target_audience', 'Target audience', s.target_audience)}
          ${F.input('s_cta', 'Preferred CTA', s.cta, { ph: 'e.g. Book now — {{Phone}}' })}
          <div class="form-row">
            ${F.input('s_seo_keywords', 'SEO keywords', s.seo_keywords)}
            ${F.input('s_branded_hashtags', 'Branded hashtags', s.branded_hashtags)}
          </div>
          <div class="divider"></div>
          <div style="font-weight:600;margin-bottom:8px;font-size:.84rem">Placeholder values <span class="hint" style="display:inline">for {{tokens}}</span></div>
          <div class="form-row">
            ${F.input('p_business_name', '{{BusinessName}}', ph.business_name)}
            ${F.input('p_service', '{{Service}}', ph.service)}
          </div>
          <div class="form-row">
            ${F.input('p_location', '{{Location}}', ph.location)}
            ${F.input('p_phone', '{{Phone}}', ph.phone)}
          </div>
          <div class="form-row">
            ${F.input('p_whatsapp', '{{WhatsApp}}', ph.whatsapp)}
            ${F.input('p_website', '{{Website}}', ph.website)}
          </div>
          <div class="form-row">
            ${F.input('p_offer', '{{Offer}}', ph.offer)}
            ${F.input('p_keywords', '{{Keywords}}', ph.keywords)}
          </div>
          <div class="field"><label>Caption template</label>
            <textarea name="caption_template" rows="9" style="font-family:ui-monospace,monospace;font-size:.78rem">${esc(tpl)}</textarea>
            <div class="hint">Sections: Hook · Problem · Solution · Benefits · CTA · Hashtags · SEO.</div></div>
        </div></div>` : ''}
      </div>
    </form>`;

  $('#saveClient').onclick = async () => {
    const form = $('#clientForm');
    const fd = new FormData(form);
    const data = {};
    const caption_settings = {};
    const placeholder_values = {};
    fd.forEach((v, k) => {
      const val = typeof v === 'string' ? v.trim() : v;
      if (k.startsWith('s_')) caption_settings[k.slice(2)] = val;
      else if (k.startsWith('p_')) placeholder_values[k.slice(2)] = val;
      else if (k !== 'caption_template') data[k] = val;
    });
    ['package_amount', 'monthly_deliverables'].forEach((k) => { if (data[k] === '') delete data[k]; });
    if (!data.portal_password) delete data.portal_password;

    try {
      if (c) {
        const pw = data.portal_password;
        delete data.portal_password;
        await Api.patch(`/api/clients/${c.id}`, data);
        if (pw) await Api.post(`/api/clients/${c.id}/portal-login`, { password: pw });
        await Api.put(`/api/clients/${c.id}/caption-config`, {
          caption_settings, placeholder_values, caption_template: fd.get('caption_template') || '',
        });
        toastOk('Client updated');
      } else {
        await Api.post('/api/clients', data);
        toastOk('Client created');
      }
      invalidateClients();
      nav('/clients');
    } catch (ex) { toastErr(errText(ex)); }
  };
});

/* ============ CAPTIONS ============ */
ERP.register('captions', async function renderCaptions(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Captions</h1><div class="sub">Every caption, stored permanently — searchable by client, month, platform & campaign</div></div>
    </div>
    <div class="filters">
      <input type="search" id="fQ" placeholder="Search captions…" value="${esc(params.get('q') || '')}" />
      <select id="fClient">${await clientOptionsHtml(params.get('client_id'))}</select>
      <select id="fPlatform"><option value="">All platforms</option>${platformOptions(params.get('platform'))}</select>
      <input type="month" id="fMonth" value="${esc(params.get('month') || '')}" />
    </div>
    <div id="capList" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))"></div>
    <div class="pager" id="capPager"></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    ['fQ:q', 'fClient:client_id', 'fPlatform:platform', 'fMonth:month'].forEach((pair) => {
      const [fid, key] = pair.split(':');
      if ($(`#${fid}`).value) p.set(key, $(`#${fid}`).value);
    });
    nav(`/captions?${p}`);
  };
  ['fClient', 'fPlatform', 'fMonth'].forEach((id) => ($(`#${id}`).onchange = apply));
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };

  const qs = new URLSearchParams({ page: pageNo, limit: 12 });
  ['q', 'client_id', 'platform', 'month'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });
  const r = await Api.get(`/api/captions?${qs}`);

  $('#capList').innerHTML = r.data.length ? r.data.map((c) => `
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px">
        <strong style="font-size:.88rem">${esc(c.company_name)}</strong>
        <span class="chip-row">${c.is_ai_generated ? '<span class="badge b-violet">AI</span>' : ''}
          <span class="badge b-gray">${esc(c.month_key || '')}</span></span>
      </div>
      <div class="copy-box" style="max-height:150px;overflow:auto">${esc(c.body)}</div>
      <div class="t-sub" style="margin:8px 0 10px">${label(c.platform || '')} ${c.campaign ? '· ' + esc(c.campaign) : ''} ${c.deliverable_title ? '· ' + esc(c.deliverable_title) : ''}</div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" data-copy="${c.id}">Copy</button>
        ${c.deliverable_id ? `<a class="btn btn-ghost btn-sm" href="#/tasks/${c.deliverable_id}">Open task</a>` : ''}
        <button class="btn btn-ghost btn-sm" style="color:var(--red);margin-left:auto" data-del="${c.id}">Delete</button>
      </div>
    </div></div>`).join('') : '<div class="card"><div class="card-body empty">No captions found</div></div>';

  $$('[data-copy]').forEach((b) => (b.onclick = () => {
    const c = r.data.find((x) => x.id === Number(b.dataset.copy));
    navigator.clipboard.writeText(c.body + (c.hashtags ? '\n\n' + c.hashtags : '')).then(() => toastOk('Caption copied'));
  }));
  $$('[data-del]').forEach((b) => (b.onclick = () =>
    confirmModal('Delete caption', 'Remove this caption from the library?', async () => {
      await Api.del(`/api/captions/${b.dataset.del}`);
      toastOk('Deleted');
      route();
    })));

  pager($('#capPager'), r.pagination, (p) => { qs.set('page', p); nav(`/captions?${qs}`); });
});

/* ============ PAYMENTS ============ */
ERP.register('payments', async function renderPayments(params) {
  const tab = params.get('tab') || 'invoices';
  const pageNo = Number(params.get('page') || 1);

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Payments</h1><div class="sub">Invoices, online payments and history</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="newInvoice"><i data-lucide="plus"></i> New Invoice</button></div>
    </div>
    <div class="tabs" style="border-bottom:1px solid var(--line);margin-bottom:14px">
      <button class="tab ${tab === 'invoices' ? 'active' : ''}" data-tab="invoices">Invoices</button>
      <button class="tab ${tab === 'history' ? 'active' : ''}" data-tab="history">Payment history</button>
    </div>
    <div class="filters">
      <select id="fClient">${await clientOptionsHtml(params.get('client_id'))}</select>
      <select id="fStatus"><option value="">All statuses</option>
        ${(tab === 'invoices' ? ['sent', 'paid', 'overdue', 'cancelled'] : ['pending', 'paid', 'failed', 'refunded'])
          .map((s) => `<option value="${s}" ${params.get('status') === s ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="payTable"></div><div class="pager" id="payPager"></div></div>`;

  const apply = (t2) => {
    const p = new URLSearchParams({ tab: t2 || tab });
    if ($('#fClient').value) p.set('client_id', $('#fClient').value);
    if ($('#fStatus').value) p.set('status', $('#fStatus').value);
    nav(`/payments?${p}`);
  };
  $$('.tab[data-tab]').forEach((b) => (b.onclick = () => apply(b.dataset.tab)));
  ['fClient', 'fStatus'].forEach((id) => ($(`#${id}`).onchange = () => apply()));
  $('#newInvoice').onclick = () => ERP.modals.invoice();

  const qs = new URLSearchParams({ page: pageNo, limit: 15 });
  ['client_id', 'status'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });

  if (tab === 'invoices') {
    const r = await Api.get(`/api/payments/invoices?${qs}`);
    $('#payTable').innerHTML = r.data.length ? `
      <table class="tbl"><thead><tr><th>Invoice</th><th>Client</th><th>Period</th><th class="num">Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
      <tbody>${r.data.map((i) => `
        <tr>
          <td class="t-main">${esc(i.invoice_no)}</td>
          <td>${esc(i.company_name)}</td>
          <td>${esc(i.period_month || '—')}</td>
          <td class="num">${fmtMoney(i.total)}</td>
          <td>${fmtDate(i.due_date)}</td>
          <td>${badge(i.status)}</td>
          <td class="row-actions"><a class="btn btn-outline btn-sm" href="#/invoice/${i.id}">View / PDF</a></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No invoices yet</div>';
    pager($('#payPager'), r.pagination, (p) => { qs.set('page', p); qs.set('tab', 'invoices'); nav(`/payments?${qs}`); });
  } else {
    const r = await Api.get(`/api/payments?${qs}`);
    $('#payTable').innerHTML = r.data.length ? `
      <table class="tbl"><thead><tr><th>Client</th><th>Invoice</th><th class="num">Amount</th><th>Method</th><th>Transaction</th><th>Paid at</th><th>Status</th><th></th></tr></thead>
      <tbody>${r.data.map((p) => `
        <tr>
          <td class="t-main">${esc(p.company_name)}</td>
          <td>${esc(p.invoice_no || '—')}</td>
          <td class="num">${fmtMoney(p.amount)}</td>
          <td>${esc(p.method || '—')}</td>
          <td class="t-sub">${esc(p.razorpay_payment_id || '—')}</td>
          <td>${p.paid_at ? fmtDateTime(p.paid_at) : '—'}</td>
          <td>${badge(p.status)}</td>
          <td class="row-actions">${p.status === 'pending' ? `<button class="btn btn-outline btn-sm" data-paid="${p.id}">Mark paid</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No payments yet</div>';
    $$('[data-paid]').forEach((b) => (b.onclick = () =>
      confirmModal('Mark as paid', 'Record this payment as received (offline/bank)?', async () => {
        await Api.post(`/api/payments/${b.dataset.paid}/mark-paid`, { method: 'bank' });
        toastOk('Payment recorded');
        route();
      }, false)));
    pager($('#payPager'), r.pagination, (p) => { qs.set('page', p); qs.set('tab', 'history'); nav(`/payments?${qs}`); });
  }
});

/* New-invoice dialog (compact) — also used by Quick Add */
ERP.modals.invoice = function invoiceFormModal() {
  getClients().then((clients) => {
    const m = modal({
      title: 'New Invoice',
      body: `<form id="invForm">
        <div class="field"><label>Client *</label>
          <select name="client_id">${clients.map((c) => `<option value="${c.id}">${esc(c.company_name)} — ${fmtMoney(c.package_amount)}</option>`).join('')}</select></div>
        <div class="form-row">
          <div class="field"><label>Amount (₹) *</label><input type="number" name="amount" min="1" step="0.01" required></div>
          <div class="field"><label>Tax (₹)</label><input type="number" name="tax" min="0" step="0.01" value="0"></div>
        </div>
        <div class="field"><label>Due date</label><input type="date" name="due_date"></div>
        <div class="field"><label>Description</label><input name="descr" placeholder="e.g. Growth Plan — social media management"></div>
        <label class="checkbox"><input type="checkbox" name="apply_fee" checked> Apply processing fee (<span id="feePct">…</span>%) &nbsp;<span class="hint" id="feePreview"></span></label>
      </form>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button>
               <button class="btn btn-primary" data-y>Create & Send</button>`,
    });
    const sel = $('#invForm [name=client_id]');
    const amt = $('#invForm [name=amount]');
    const feeChk = $('#invForm [name=apply_fee]');
    let feePercent = 0;
    const updatePreview = () => {
      const base = Number(amt.value || 0) + Number($('#invForm [name=tax]').value || 0);
      const fee = feeChk.checked ? Math.round(base * (feePercent / 100) * 100) / 100 : 0;
      $('#feePreview').textContent = fee > 0 ? `→ Total ${fmtMoney(base + fee)}` : '';
    };
    Api.get('/api/settings').then((sr) => {
      feePercent = Number(sr.data.processing_fee_percent || 0);
      $('#feePct').textContent = feePercent;
      updatePreview();
    }).catch(() => { $('#feePct').textContent = '0'; });
    const prefill = () => {
      const c = clients.find((x) => x.id === Number(sel.value));
      if (c && c.package_amount > 0) amt.value = c.package_amount;
      updatePreview();
    };
    sel.onchange = prefill; prefill();
    amt.oninput = updatePreview;
    $('#invForm [name=tax]').oninput = updatePreview;
    feeChk.onchange = updatePreview;
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = async () => {
      const fd = new FormData($('#invForm'));
      try {
        const res = await Api.post('/api/payments/invoices', {
          client_id: Number(fd.get('client_id')),
          amount: Number(fd.get('amount')),
          tax: Number(fd.get('tax') || 0),
          apply_processing_fee: feeChk.checked,
          due_date: fd.get('due_date') || undefined,
          line_items: [{ description: fd.get('descr') || 'Services', qty: 1, rate: Number(fd.get('amount')) }],
        });
        toastOk(`Invoice ${res.data.invoice_no} created`);
        m.close();
        route();
      } catch (ex) { toastErr(errText(ex)); }
    };
  });
};

/* ============ INVOICE VIEW (printable) ============ */
ERP.register('invoice', async function renderInvoice(id) {
  const r = await Api.get(`/api/payments/invoices/${id}`);
  const inv = r.data;
  const ag = inv.agency || {};
  const items = (typeof inv.line_items === 'string' ? JSON.parse(inv.line_items || '[]') : inv.line_items) || [];
  const logoBox = ag.logo
    ? `<img src="${esc(ag.logo)}" alt="logo" style="height:40px;border-radius:8px">`
    : `<div style="width:40px;height:40px;border-radius:10px;background:var(--primary);color:#fff;display:grid;place-items:center;font-weight:800">${esc((ag.name || 'A')[0])}</div>`;
  page.innerHTML = `
    <div class="page-head no-print">
      <a class="link-btn" href="#/payments">← Back to payments</a>
      <div class="head-actions">
        <button class="btn btn-primary js-print"><i data-lucide="printer"></i> Print / Save PDF</button>
      </div>
    </div>
    <div class="card" style="max-width:760px;margin:0 auto"><div class="card-body" style="padding:34px">
      <div style="display:flex;justify-content:space-between;margin-bottom:26px;gap:12px;flex-wrap:wrap">
        <div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            ${logoBox}
            <strong style="font-size:1.15rem">${esc(ag.name || 'Agency ERP')}</strong>
          </div>
          <div class="t-sub">${esc(ag.address || 'Digital Marketing Services')}</div>
          <div class="t-sub">${[ag.email, ag.contact].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div style="text-align:right">
          <h2 style="color:var(--primary);margin-bottom:4px">INVOICE</h2>
          <div><strong>${esc(inv.invoice_no)}</strong></div>
          <div class="t-sub">Issued: ${fmtDate(inv.issue_date)}</div>
          <div class="t-sub">Due: ${fmtDate(inv.due_date)}</div>
          <div style="margin-top:6px">${badge(inv.status)}</div>
        </div>
      </div>
      <div style="margin-bottom:22px">
        <div class="t-sub" style="text-transform:uppercase;letter-spacing:.05em;font-size:.7rem">Billed to</div>
        <strong>${esc(inv.company_name)}</strong>
        <div class="t-sub">${esc(inv.contact_person || '')} ${inv.client_email ? '· ' + esc(inv.client_email) : ''} ${inv.client_phone ? '· ' + esc(inv.client_phone) : ''}</div>
      </div>
      <table class="tbl" style="margin-bottom:18px"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${items.map((it) => `
        <tr><td>${esc(it.description)}</td><td class="num">${it.qty}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${fmtMoney(it.qty * it.rate)}</td></tr>`).join('')}
      </tbody></table>
      <div style="max-width:280px;margin-left:auto">
        <div class="kv"><span class="k">Subtotal</span><span class="v">${fmtMoney(inv.amount)}</span></div>
        ${Number(inv.tax) > 0 ? `<div class="kv"><span class="k">Tax (GST)</span><span class="v">${fmtMoney(inv.tax)}</span></div>` : ''}
        ${Number(inv.processing_fee) > 0 ? `<div class="kv"><span class="k">Processing fee</span><span class="v">${fmtMoney(inv.processing_fee)}</span></div>` : ''}
        <div class="kv" style="border:none"><span class="k" style="font-weight:700">Total</span>
          <span class="v" style="font-size:1.15rem;color:var(--primary)">${fmtMoney(inv.total)}</span></div>
      </div>
      ${inv.notes ? `<div class="divider"></div><div class="t-sub">${esc(inv.notes)}</div>` : ''}
      <div class="divider"></div>
      <div class="t-sub">Payments: ${inv.payments.length ? inv.payments.map((p) => `${fmtMoney(p.amount)} — ${label(p.status)}${p.paid_at ? ' on ' + fmtDate(p.paid_at) : ''}`).join(' · ') : 'none recorded'}</div>
      <div class="t-sub" style="text-align:center;margin-top:16px;color:var(--ink-3)">${esc(ag.powered_by || 'Powered by Venkat')}</div>
    </div></div>`;
});

/* ============ ANALYTICS ============ */
ERP.register('analytics', async function renderAnalytics(params) {
  const clients = await getClients();
  if (!clients.length) {
    page.innerHTML = '<div class="card"><div class="card-body empty">Add a client first to see analytics.</div></div>';
    return;
  }
  const clientId = Number(params.get('client_id')) || clients[0].id;
  const days = Number(params.get('days')) || 30;
  const platform = params.get('platform') === 'youtube' ? 'youtube' : 'instagram';
  const isYT = platform === 'youtube';

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Analytics</h1><div class="sub">${isYT ? 'YouTube channel performance via YouTube Data API' : 'Instagram / Facebook performance via Meta Graph API'}</div></div>
      <div class="head-actions">
        <select id="anClient" style="padding:8px 11px;border:1px solid var(--line);border-radius:9px">
          ${clients.map((c) => `<option value="${c.id}" ${c.id === clientId ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}</select>
        <select id="anPlatform" style="padding:8px 11px;border:1px solid var(--line);border-radius:9px">
          <option value="instagram" ${!isYT ? 'selected' : ''}>Instagram</option>
          <option value="youtube" ${isYT ? 'selected' : ''}>YouTube</option>
        </select>
        <select id="anDays" style="padding:8px 11px;border:1px solid var(--line);border-radius:9px">
          ${[7, 30, 90].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>
        <button class="btn btn-outline" id="syncBtn"><i data-lucide="refresh-cw"></i> Sync now</button>
      </div>
    </div>
    <div id="anBody"><div class="empty">Loading analytics…</div></div>`;

  const goNav = () => nav(`/analytics?client_id=${$('#anClient').value}&platform=${$('#anPlatform').value}&days=${$('#anDays').value}`);
  $('#anClient').onchange = goNav;
  $('#anPlatform').onchange = goNav;
  $('#anDays').onchange = goNav;
  $('#syncBtn').onclick = async () => {
    const res = await Api.post('/api/analytics/sync');
    (res.data.live ? toastOk : toastErr)(res.message);
    if (res.data.live) route();
  };

  const r = await Api.get(`/api/analytics/overview?client_id=${clientId}&platform=${platform}&days=${days}`);
  const { summary, series, best_content: best, comparisons: cmp, live } = r.data;

  if (!summary) {
    $('#anBody').innerHTML = `<div class="card"><div class="card-body empty">No ${isYT ? 'YouTube' : 'Instagram'} data yet for this client. ${isYT ? 'Add the client’s YouTube channel id and set YOUTUBE_API_KEY, then press "Sync now".' : 'Configure META_GRAPH_TOKEN + the IG account id, then press "Sync now".'}</div></div>`;
    return;
  }

  const stat = (lbl, val, extra = '') => `
    <div class="stat"><div style="min-width:0">
      <div class="s-val">${val}</div><div class="s-label">${lbl}</div>${extra}</div></div>`;
  const trend = (pct) => pct === null ? '' :
    `<div class="s-trend ${pct >= 0 ? 'trend-up' : 'trend-down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous</div>`;

  const statsCards = isYT ? `
      ${stat('Subscribers', fmtNum(summary.followers), `<div class="s-trend trend-up">+${fmtNum(summary.follower_growth)} in ${days}d</div>`)}
      ${stat('Total views', fmtNum(summary.views))}`
    : `
      ${stat('Followers', fmtNum(summary.followers), `<div class="s-trend trend-up">+${fmtNum(summary.follower_growth)} in ${days}d</div>`)}
      ${stat('Reach', fmtNum(summary.reach), trend(cmp.weekly.change_pct))}
      ${stat('Impressions', fmtNum(summary.impressions))}
      ${stat('Views', fmtNum(summary.views))}
      ${stat('Likes', fmtNum(summary.likes))}
      ${stat('Comments', fmtNum(summary.comments))}
      ${stat('Shares', fmtNum(summary.shares))}
      ${stat('Saves', fmtNum(summary.saves))}
      ${stat('Engagement Rate', summary.engagement_rate + '%')}`;

  $('#anBody').innerHTML = `
    ${live ? '' : `<div class="card" style="margin-bottom:14px"><div class="card-body" style="font-size:.85rem;color:var(--amber)">⚠ ${isYT ? 'YouTube Data API' : 'Meta Graph API'} not configured — showing stored snapshot history (demo data). Set ${isYT ? 'YOUTUBE_API_KEY' : 'META_GRAPH_TOKEN'} in .env for live metrics.</div></div>`}
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>🤖 AI Growth Insights</h3><span class="badge b-violet" id="insProvider">…</span></div>
      <div class="card-body" id="insBody"><div class="t-sub">Analyzing…</div></div></div>
    <div class="grid stats-grid" style="margin-bottom:16px">${statsCards}</div>
    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card"><div class="card-head"><h3>${isYT ? 'Subscriber growth' : 'Follower growth'}</h3></div>
        <div class="card-body"><canvas id="chFollowers" data-h="220" style="width:100%"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>${isYT ? 'Total views' : 'Daily reach'}</h3></div>
        <div class="card-body"><canvas id="chReach" data-h="220" style="width:100%"></canvas></div></div>
    </div>
    <div class="grid grid-2">
      ${isYT ? '' : `<div class="card">
        <div class="card-head"><h3>Comparisons</h3></div>
        <div class="card-body">
          <div class="kv"><span class="k">Weekly reach</span><span class="v">${fmtNum(cmp.weekly.current)} ${trend(cmp.weekly.change_pct)}</span></div>
          <div class="kv"><span class="k">Previous week</span><span class="v">${fmtNum(cmp.weekly.previous)}</span></div>
          <div class="kv"><span class="k">Monthly reach</span><span class="v">${fmtNum(cmp.monthly.current)} ${trend(cmp.monthly.change_pct)}</span></div>
          <div class="kv"><span class="k">Previous month</span><span class="v">${fmtNum(cmp.monthly.previous)}</span></div>
        </div>
      </div>`}
      <div class="card">
        <div class="card-head"><h3>Best performing content</h3></div>
        <div class="card-body flush">
          ${best.length ? best.map((b) => `
            <div class="notif-item" style="cursor:pointer" data-nav="/tasks/${b.id}">
              <div class="n-title">${esc(b.title)} ${b.ai_score ? `<strong style="color:${scoreColor(b.ai_score)}">· ${b.ai_score}</strong>` : ''}</div>
              <div class="n-body">${label(b.platform)} · posted ${b.posted_at ? fmtDate(b.posted_at) : '—'}</div>
            </div>`).join('') : '<div class="empty">No posted content yet</div>'}
        </div>
      </div>
    </div>`;

  const pts = series.map((sx) => ({ label: String(sx.snapshot_date).slice(5), value: Number(sx.followers) }));
  lineChart($('#chFollowers'), [{ name: isYT ? 'Subscribers' : 'Followers', color: '#4527a0', points: pts }]);
  const secondPts = series.map((sx) => ({ label: String(sx.snapshot_date).slice(5), value: Number(isYT ? sx.views : sx.reach) }));
  lineChart($('#chReach'), [{ name: isYT ? 'Views' : 'Reach', color: '#1258a8', points: secondPts }]);

  Api.get(`/api/analytics/insights?client_id=${clientId}`).then((ins) => {
    const d = ins.data;
    const provEl = $('#insProvider');
    if (provEl) provEl.textContent = d.provider;
    const body = $('#insBody');
    if (!body) return;
    body.innerHTML = `
      <div class="grid grid-3" style="gap:12px">
        <div><div class="t-sub">Best posting time</div><strong>${esc(d.best_posting_time)}</strong></div>
        <div><div class="t-sub">Best content type</div><strong>${esc(d.best_content_type)}</strong></div>
        <div><div class="t-sub">Posting frequency</div><strong>${esc(d.posting_frequency)}</strong></div>
      </div>
      <div class="divider"></div>
      <div class="grid grid-3" style="gap:16px">
        <div><div style="font-weight:600;font-size:.82rem;margin-bottom:5px">📈 Growth</div>
          <ul style="font-size:.83rem;color:var(--ink-2);padding-left:16px">${(d.growth_suggestions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><div style="font-weight:600;font-size:.82rem;margin-bottom:5px">✍️ Captions</div>
          <ul style="font-size:.83rem;color:var(--ink-2);padding-left:16px">${(d.caption_improvements || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><div style="font-weight:600;font-size:.82rem;margin-bottom:5px"># Hashtags</div>
          <div class="chip-row">${(d.hashtag_suggestions || []).map((x) => `<span class="badge b-gray">${esc(x)}</span>`).join('')}</div></div>
      </div>`;
  }).catch(() => { const b = $('#insBody'); if (b) b.innerHTML = '<div class="t-sub">Insights unavailable.</div>'; });
});

/* ============ REPORTS ============ */
ERP.register('reports', async function renderReports(params) {
  const type = params.get('type') || 'monthly';
  const month = params.get('month') || thisMonth();
  const clientId = params.get('client_id') || '';

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Reports</h1><div class="sub">Generate, print (PDF) and export (Excel/CSV)</div></div>
      <div class="head-actions no-print">
        <button class="btn btn-outline" id="csvBtn"><i data-lucide="file-spreadsheet"></i> Export Excel/CSV</button>
        <button class="btn btn-primary js-print"><i data-lucide="printer"></i> Print / PDF</button>
      </div>
    </div>
    <div class="filters no-print">
      <select id="rType">
        ${['monthly', 'client', 'deliverables', 'promotion', 'payment', 'performance']
          .map((tp) => `<option value="${tp}" ${type === tp ? 'selected' : ''}>${label(tp)} report</option>`).join('')}
      </select>
      <input type="month" id="rMonth" value="${month}" />
      <select id="rClient">${await clientOptionsHtml(clientId)}</select>
    </div>
    <div class="card"><div class="card-head"><h3 id="repTitle">…</h3><span id="repSummary" class="t-sub"></span></div>
      <div class="card-body flush table-wrap" id="repTable"></div></div>`;

  const apply = () => {
    const p = new URLSearchParams({ type: $('#rType').value, month: $('#rMonth').value });
    if ($('#rClient').value) p.set('client_id', $('#rClient').value);
    nav(`/reports?${p}`);
  };
  ['rType', 'rMonth', 'rClient'].forEach((id) => ($(`#${id}`).onchange = apply));

  const qs = new URLSearchParams({ month });
  if (clientId) qs.set('client_id', clientId);
  const r = await Api.get(`/api/reports/${type}?${qs}`);
  $('#repTitle').textContent = r.data.title;
  $('#repSummary').textContent = Object.entries(r.data.summary || {})
    .map(([k, v]) => `${label(k)}: ${typeof v === 'number' && k.includes('received') ? fmtMoney(v) : fmtNum(v)}`).join(' · ');

  const rows = r.data.rows || [];
  if (!rows.length) {
    $('#repTable').innerHTML = '<div class="empty">No data for this selection</div>';
  } else {
    const headers = Object.keys(rows[0]);
    $('#repTable').innerHTML = `
      <table class="tbl"><thead><tr>${headers.map((h) => `<th>${label(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${headers.map((h) => {
        const v = row[h];
        if (h.includes('status')) return `<td>${badge(v)}</td>`;
        if (h.includes('date') || h.includes('_at')) return `<td>${fmtDate(v)}</td>`;
        if (h === 'amount') return `<td>${fmtMoney(v)}</td>`;
        return `<td>${esc(v ?? '—')}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`;
  }

  $('#csvBtn').onclick = async () => {
    const res = await fetch(`/api/reports/${type}/csv?${qs}`, {
      headers: { Authorization: `Bearer ${Api.getToken()}` },
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${type}-report-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
});

/* ============ ACTIVITY ============ */
ERP.register('activity', async function renderActivity(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head"><div><h1>Activity Log</h1><div class="sub">Full audit trail of every action</div></div></div>
    <div class="filters"><input type="search" id="fQ" placeholder="Search activity…" value="${esc(params.get('q') || '')}" /></div>
    <div class="card"><div class="card-body flush table-wrap" id="actTable"></div><div class="pager" id="actPager"></div></div>`;

  let t; $('#fQ').oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => nav(`/activity?q=${encodeURIComponent($('#fQ').value)}`), 350);
  };

  const qs = new URLSearchParams({ page: pageNo, limit: 30 });
  if (params.get('q')) qs.set('q', params.get('q'));
  const r = await Api.get(`/api/activity?${qs}`);
  $('#actTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
    <tbody>${r.data.map((a) => `
      <tr>
        <td style="white-space:nowrap">${fmtDateTime(a.created_at)}</td>
        <td class="t-main">${esc(a.actor_name || 'System')}</td>
        <td><span class="badge b-gray">${esc(a.action)}</span></td>
        <td>${esc(a.description || '')}</td>
        <td class="t-sub">${esc(a.ip_address || '')}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No activity found</div>';
  pager($('#actPager'), r.pagination, (p) => { qs.set('page', p); nav(`/activity?${qs}`); });
});

/* ============ TEAM ============ */
ERP.register('team', async function renderTeam() {
  if (user.role !== 'super_admin') { nav('/dashboard'); return; }
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Team</h1><div class="sub">Admins and super admins</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="addUser"><i data-lucide="user-plus"></i> Add Member</button></div>
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="teamTable"></div></div>`;

  $('#addUser').onclick = () => teamFormModal();
  const r = await Api.get('/api/users?limit=100');
  $('#teamTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th>Status</th><th></th></tr></thead>
    <tbody>${r.data.map((u) => `
      <tr>
        <td class="t-main">${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td>${label(u.role)}</td>
        <td>${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
        <td>${u.is_active ? badge('active') : badge('inactive')}</td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm" data-edit="${u.id}">Edit</button>
          ${u.id !== user.id ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del="${u.id}">Deactivate</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No team members</div>';

  $$('[data-edit]').forEach((b) => (b.onclick = () => teamFormModal(r.data.find((x) => x.id === Number(b.dataset.edit)))));
  $$('[data-del]').forEach((b) => (b.onclick = () =>
    confirmModal('Deactivate member', 'They will no longer be able to sign in.', async () => {
      await Api.del(`/api/users/${b.dataset.del}`);
      toastOk('Member deactivated');
      route();
    })));
});

function teamFormModal(u = null) {
  const m = modal({
    title: u ? `Edit — ${u.name}` : 'Add team member',
    body: `<form id="teamForm">
      <div class="field"><label>Name *</label><input name="name" value="${esc(u?.name || '')}" required></div>
      ${u ? '' : '<div class="field"><label>Email *</label><input type="email" name="email" required></div>'}
      <div class="form-row">
        <div class="field"><label>Role</label>
          <select name="role">
            <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="super_admin" ${u?.role === 'super_admin' ? 'selected' : ''}>Super Admin</option>
            <option value="poster_designer" ${u?.role === 'poster_designer' ? 'selected' : ''}>Poster Designer</option>
          </select></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(u?.phone || '')}"></div>
      </div>
      <div class="field"><label>${u ? 'New password (leave blank to keep)' : 'Password *'}</label>
        <input type="text" name="password" ${u ? '' : 'required'} placeholder="Min 8 chars, letters + numbers"></div>
      ${u ? `<label class="checkbox"><input type="checkbox" name="is_active" ${u.is_active ? 'checked' : ''}> Active</label>` : ''}
    </form>`,
    footer: `<button class="btn btn-outline" data-x>Cancel</button>
             <button class="btn btn-primary" data-y>${u ? 'Save' : 'Create'}</button>`,
  });
  $('[data-x]', m.foot).onclick = m.close;
  $('[data-y]', m.foot).onclick = async () => {
    const form = $('#teamForm');
    const fd = new FormData(form);
    const data = { name: fd.get('name'), role: fd.get('role'), phone: fd.get('phone') || undefined };
    if (fd.get('password')) data.password = fd.get('password');
    try {
      if (u) {
        data.is_active = form.querySelector('[name=is_active]')?.checked ?? true;
        await Api.patch(`/api/users/${u.id}`, data);
      } else {
        data.email = fd.get('email');
        await Api.post('/api/users', data);
      }
      toastOk(u ? 'Member updated' : 'Member added');
      m.close();
      route();
    } catch (ex) { toastErr(errText(ex)); }
  };
}

/* ============ SETTINGS ============ */
ERP.register('settings', async function renderSettings() {
  if (user.role !== 'super_admin') { nav('/dashboard'); return; }
  page.innerHTML = '<div class="empty">Loading settings…</div>';
  const r = await Api.get('/api/settings');
  const s = r.data;

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Settings</h1><div class="sub">Agency branding, payments and invoicing — used across invoices, emails and checkout</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="saveSettings"><i data-lucide="save"></i> Save Settings</button></div>
    </div>
    <form id="settingsForm" class="grid grid-2" style="align-items:start">
      <div class="card"><div class="card-head"><h3>Company / branding</h3></div><div class="card-body">
        ${F.input('company_name', 'Company name', s.company_name)}
        ${F.input('powered_by', 'Footer tagline', s.powered_by)}
        <div class="form-row">
          ${F.input('company_email', 'Company email', s.company_email, { type: 'email' })}
          ${F.input('contact_number', 'Contact number', s.contact_number)}
        </div>
        ${F.input('company_logo_url', 'Company logo URL', s.company_logo_url, { type: 'url' })}
        ${F.area('business_address', 'Business address', s.business_address, { rows: 3 })}
      </div></div>
      <div class="card"><div class="card-head"><h3>Payments & invoicing</h3></div><div class="card-body">
        <div class="form-row">
          ${F.input('invoice_prefix', 'Invoice prefix', s.invoice_prefix)}
          ${F.input('processing_fee_percent', 'Processing fee %', s.processing_fee_percent, { type: 'number', extra: 'min="0" max="100" step="0.01"' })}
        </div>
        <div class="field"><span class="hint">Clients are invoiced: <strong>Package + (Package × Fee%)</strong>. e.g. ₹10,000 + 2.60% = ₹10,260.</span></div>
        <div class="divider"></div>
        <div style="font-weight:600;font-size:.88rem;margin-bottom:8px">Razorpay
          <span class="badge ${s.razorpay_key_secret_set ? 'b-green' : 'b-gray'}">${s.razorpay_key_secret_set ? 'Configured' : 'Not set (demo mode)'}</span></div>
        ${F.input('razorpay_key_id', 'Razorpay Key ID', s.razorpay_key_id)}
        <div class="field"><label>Razorpay Key Secret</label>
          <input type="password" name="razorpay_key_secret" placeholder="${s.razorpay_key_secret_set ? '•••••••• (leave blank to keep)' : 'rzp secret'}">
          <div class="hint">Stored securely; leave blank to keep the existing secret. With both keys set, live payments replace demo mode.</div></div>
      </div></div>
    </form>`;

  $('#saveSettings').onclick = async () => {
    const fd = new FormData($('#settingsForm'));
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    if (!data.razorpay_key_secret) delete data.razorpay_key_secret;
    try {
      await Api.put('/api/settings', data);
      toastOk('Settings saved');
      route();
    } catch (ex) { toastErr(errText(ex)); }
  };
});

/* ============ AI CLIENT DETECT ============ */
ERP.register('detect', async function renderDetect() {
  await getClients();
  const aiStatus = await Api.get('/api/ai/status').catch(() => ({ data: { openai: false } }));
  page.innerHTML = `
    <div class="page-head">
      <div><h1>AI Client Detection</h1><div class="sub">Identify which client a creative belongs to from its logo, watermark or brand text — then teach the system</div></div>
    </div>
    ${aiStatus.data.openai ? '' : '<div class="card" style="margin-bottom:14px"><div class="card-body" style="font-size:.85rem;color:var(--amber)">⚠ OpenAI vision not configured — image analysis is unavailable. You can still detect by typing the brand text below (fuzzy-matched against clients + learned cues). Set OPENAI_API_KEY for logo/watermark image detection.</div></div>'}
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Detect</h3></div><div class="card-body">
        <div class="field"><label>Image URL (logo / watermark / poster)</label>
          <input id="imgUrl" placeholder="https://…/creative.jpg" ${aiStatus.data.openai ? '' : 'disabled'}>
          <div class="hint">${aiStatus.data.openai ? 'Publicly accessible image URL.' : 'Enable OpenAI vision to use image detection.'}</div></div>
        <div class="field"><label>…or brand text</label>
          <input id="brandText" placeholder="e.g. Spice Route"></div>
        <button class="btn btn-primary" id="detectBtn"><i data-lucide="scan-search"></i> Detect Client</button>
      </div></div>
      <div class="card"><div class="card-head"><h3>Result</h3></div><div class="card-body" id="detectResult">
        <div class="empty">Run a detection to see the matched client, confidence and candidates.</div>
      </div></div>
    </div>`;

  $('#detectBtn').onclick = async () => {
    const image_url = $('#imgUrl').value.trim();
    const brand_text = $('#brandText').value.trim();
    if (!image_url && !brand_text) return toastErr('Enter an image URL or brand text');
    const box = $('#detectResult');
    box.innerHTML = '<div class="empty">Analyzing…</div>';
    try {
      const res = await Api.post('/api/ai/detect-client', { image_url: image_url || undefined, brand_text: brand_text || undefined });
      renderDetectResult(box, res.data, { image_url, brand_text });
    } catch (ex) { box.innerHTML = `<div class="empty">⚠️ ${esc(ex.message)}</div>`; }
  };
});

function renderDetectResult(box, data, input) {
  const clients = clientCache || [];
  const primaryCue = (data.cues && data.cues[0]) || input.brand_text || '';
  const extractedRows = Object.entries(data.extracted || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="kv"><span class="k">${label(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

  box.innerHTML = `
    ${extractedRows ? `<div style="font-weight:600;font-size:.85rem;margin-bottom:6px">Extracted cues ${data.live ? '<span class="badge b-violet">vision</span>' : '<span class="badge b-gray">text</span>'}</div>${extractedRows}<div class="divider"></div>` : ''}
    ${data.match
      ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
           <div style="background:var(--green-bg);color:var(--green);width:40px;height:40px;border-radius:10px;display:grid;place-items:center"><i data-lucide="check"></i></div>
           <div><div style="font-weight:700">${esc(data.match.company_name)}</div>
             <div class="t-sub">${Math.round(data.match.confidence * 100)}% confidence</div></div>
         </div>`
      : '<div class="badge b-amber" style="margin-bottom:10px">No confident match — confirm below to teach the system</div>'}
    <div style="font-weight:600;font-size:.82rem;margin:8px 0 4px">Candidates</div>
    <div>${(data.candidates || []).map((c) => `
      <div class="kv"><span class="k">${esc(c.company_name)}</span>
        <span class="v">${Math.round(c.confidence * 100)}%</span></div>`).join('') || '<div class="t-sub">No clients to compare</div>'}</div>
    <div class="divider"></div>
    <div style="font-weight:600;font-size:.82rem;margin-bottom:6px">Confirm & learn</div>
    <div class="form-row" style="align-items:end">
      <div class="field" style="margin:0"><label>Client</label>
        <select id="confirmClient">${clients.map((c) => `<option value="${c.id}" ${data.match && data.match.client_id === c.id ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}</select></div>
      <div class="field" style="margin:0"><label>Cue to learn</label>
        <input id="confirmCue" value="${esc(primaryCue)}"></div>
    </div>
    <button class="btn btn-primary btn-sm" id="confirmBtn" style="margin-top:8px"><i data-lucide="graduation-cap"></i> Confirm & Learn</button>`;

  icons();
  $('#confirmBtn').onclick = async () => {
    const client_id = Number($('#confirmClient').value);
    const cue_value = $('#confirmCue').value.trim();
    if (!cue_value) return toastErr('Enter a cue to learn');
    try {
      const res = await Api.post('/api/ai/confirm-client', { client_id, cue_value, cue_type: input.image_url ? 'logo' : 'brand_text' });
      toastOk(res.message);
    } catch (ex) { toastErr(ex.message); }
  };
}

/* ============ SCRIPT LIBRARY ============ */
ERP.register('scripts', async function renderScripts(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Scripts</h1><div class="sub">Reusable scripts organised by client & month</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="newScript"><i data-lucide="plus"></i> New Script</button></div>
    </div>
    <div class="filters">
      <input type="search" id="fQ" placeholder="Search scripts…" value="${esc(params.get('q') || '')}" />
      <select id="fClient">${await clientOptionsHtml(params.get('client_id'))}</select>
      <input type="month" id="fMonth" value="${esc(params.get('month') || '')}" />
    </div>
    <div id="scriptList" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))"></div>
    <div class="pager" id="scriptPager"></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    if ($('#fQ').value) p.set('q', $('#fQ').value);
    if ($('#fClient').value) p.set('client_id', $('#fClient').value);
    if ($('#fMonth').value) p.set('month', $('#fMonth').value);
    nav(`/scripts?${p}`);
  };
  ['fClient', 'fMonth'].forEach((id) => ($(`#${id}`).onchange = apply));
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };
  $('#newScript').onclick = () => ERP.modals.script();

  const qs = new URLSearchParams({ page: pageNo, limit: 12 });
  ['q', 'client_id', 'month'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });
  const r = await Api.get(`/api/library/scripts?${qs}`);

  $('#scriptList').innerHTML = r.data.length ? r.data.map((s) => `
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px">
        <strong>${esc(s.title)}</strong><span class="badge b-gray">${esc(s.month_key || '')}</span>
      </div>
      <div class="t-sub" style="margin-bottom:8px">${esc(s.company_name)} ${s.platform ? '· ' + label(s.platform) : ''}</div>
      <div class="copy-box" style="max-height:160px;overflow:auto">${esc(s.body)}</div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-outline btn-sm" data-copy="${s.id}">Copy</button>
        <button class="btn btn-ghost btn-sm" data-edit="${s.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);margin-left:auto" data-del="${s.id}">Delete</button>
      </div>
    </div></div>`).join('') : '<div class="card"><div class="card-body empty">No scripts yet</div></div>';

  $$('[data-copy]').forEach((b) => (b.onclick = () => {
    const s = r.data.find((x) => x.id === Number(b.dataset.copy));
    navigator.clipboard.writeText(s.body).then(() => toastOk('Script copied'));
  }));
  $$('[data-edit]').forEach((b) => (b.onclick = () => ERP.modals.script(r.data.find((x) => x.id === Number(b.dataset.edit)))));
  $$('[data-del]').forEach((b) => (b.onclick = () => confirmModal('Delete script', 'Remove this script?', async () => {
    await Api.del(`/api/library/scripts/${b.dataset.del}`);
    toastOk('Deleted');
    route();
  })));
  pager($('#scriptPager'), r.pagination, (p) => { qs.set('page', p); nav(`/scripts?${qs}`); });
});

ERP.modals.script = function scriptFormModal(s = null) {
  getClients().then((clients) => {
    const m = modal({
      title: s ? `Edit script — ${s.title}` : 'New Script',
      wide: true,
      body: `<form id="scriptForm">
        ${s ? '' : `<div class="field"><label>Client *</label><select name="client_id">${clients.map((c) => `<option value="${c.id}">${esc(c.company_name)}</option>`).join('')}</select></div>`}
        <div class="form-row">
          <div class="field"><label>Title *</label><input name="title" value="${esc(s?.title || '')}" required></div>
          <div class="field"><label>Platform</label><select name="platform"><option value="">—</option>${platformOptions(s?.platform)}</select></div>
        </div>
        <div class="field"><label>Script body *</label><textarea name="body" rows="10" required>${esc(s?.body || '')}</textarea></div>
      </form>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button><button class="btn btn-primary" data-y>${s ? 'Save' : 'Create'}</button>`,
    });
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = async () => {
      const fd = new FormData($('#scriptForm'));
      const data = {}; fd.forEach((v, k) => { if (v !== '') data[k] = v; });
      try {
        if (s) await Api.patch(`/api/library/scripts/${s.id}`, data);
        else await Api.post('/api/library/scripts', data);
        toastOk(s ? 'Script updated' : 'Script saved');
        m.close();
        route();
      } catch (ex) { toastErr(errText(ex)); }
    };
  });
};

/* ============ THUMBNAIL LIBRARY ============ */
ERP.register('thumbnails', async function renderThumbnails(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Thumbnails</h1><div class="sub">Saved thumbnails & posters per client</div></div>
      <div class="head-actions"><button class="btn btn-primary" id="newThumb"><i data-lucide="plus"></i> Add Thumbnail</button></div>
    </div>
    <div class="filters">
      <input type="search" id="fQ" placeholder="Search…" value="${esc(params.get('q') || '')}" />
      <select id="fClient">${await clientOptionsHtml(params.get('client_id'))}</select>
    </div>
    <div id="thumbGrid" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))"></div>
    <div class="pager" id="thumbPager"></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    if ($('#fQ').value) p.set('q', $('#fQ').value);
    if ($('#fClient').value) p.set('client_id', $('#fClient').value);
    nav(`/thumbnails?${p}`);
  };
  $('#fClient').onchange = apply;
  let t; $('#fQ').oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };
  $('#newThumb').onclick = () => ERP.modals.thumbnail();

  const qs = new URLSearchParams({ page: pageNo, limit: 16 });
  ['q', 'client_id'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });
  const r = await Api.get(`/api/library/thumbnails?${qs}`);

  $('#thumbGrid').innerHTML = r.data.length ? r.data.map((th) => `
    <div class="card"><div class="card-body" style="padding:10px">
      <img src="${esc(th.image_url)}" alt="${esc(th.title || 'thumbnail')}" style="width:100%;height:130px;object-fit:cover;border-radius:8px;background:var(--bg-2)" loading="lazy">
      <div style="font-size:.82rem;font-weight:600;margin-top:8px">${esc(th.title || 'Untitled')}</div>
      <div class="t-sub">${esc(th.company_name)}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <a class="btn btn-outline btn-sm" href="${esc(th.image_url)}" target="_blank" rel="noopener">Open</a>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);margin-left:auto" data-del="${th.id}">Delete</button>
      </div>
    </div></div>`).join('') : '<div class="card"><div class="card-body empty">No thumbnails yet</div></div>';

  $$('[data-del]').forEach((b) => (b.onclick = () => confirmModal('Delete thumbnail', 'Remove this thumbnail?', async () => {
    await Api.del(`/api/library/thumbnails/${b.dataset.del}`);
    toastOk('Deleted');
    route();
  })));
  pager($('#thumbPager'), r.pagination, (p) => { qs.set('page', p); nav(`/thumbnails?${qs}`); });
});

ERP.modals.thumbnail = function thumbFormModal() {
  getClients().then((clients) => {
    const m = modal({
      title: 'Add Thumbnail',
      body: `<form id="thumbForm">
        <div class="field"><label>Client *</label><select name="client_id">${clients.map((c) => `<option value="${c.id}">${esc(c.company_name)}</option>`).join('')}</select></div>
        <div class="field"><label>Title</label><input name="title" placeholder="e.g. Diwali poster"></div>
        <div class="field"><label>Image URL *</label><input name="image_url" required placeholder="https://…/image.jpg"></div>
        <div class="field"><label>Platform</label><select name="platform"><option value="">—</option>${platformOptions()}</select></div>
      </form>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button><button class="btn btn-primary" data-y>Save</button>`,
    });
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = async () => {
      const fd = new FormData($('#thumbForm'));
      const data = {}; fd.forEach((v, k) => { if (v !== '') data[k] = v; });
      try {
        await Api.post('/api/library/thumbnails', data);
        toastOk('Thumbnail saved');
        m.close();
        route();
      } catch (ex) { toastErr(errText(ex)); }
    };
  });
};
