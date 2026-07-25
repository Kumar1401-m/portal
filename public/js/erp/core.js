/**
 * ERP core — shared constants, helpers, app-shell wiring (sidebar, topbar,
 * quick add, notifications, global search) and the hash router.
 *
 * Page modules register themselves via ERP.register(name, renderFn); the
 * router resolves aliases so legacy links (#/deliverables/12) keep working.
 * Strict CSP: no inline handlers anywhere.
 */
'use strict';

/* eslint-disable no-unused-vars */
const {
  $, $$, escapeHtml: esc, fmtMoney, fmtNum, fmtDate, fmtDateTime, timeAgo, label, badge,
  toastOk, toastErr, modal, confirmModal, barChart, lineChart, donutChart,
  calendar, calendarWeek, pager, icons, scoreColor,
} = UI;

const user = Api.getUser();
if (!user || user.role === 'client') window.location.href = '/';

/* ---------------- domain constants ---------------- */

const PLATFORMS = [
  'instagram_reel', 'instagram_post', 'instagram_story', 'facebook_post',
  'youtube_short', 'youtube_long', 'poster', 'ad_creative', 'other',
];

/** Ordered production workflow (Status Workflow spec). */
const STATUS_FLOW = [
  'pending', 'content_review', 'waiting_for_raw', 'raw_uploaded', 'editing', 'caption_ready',
  'review', 'approved', 'scheduled', 'posted', 'completed',
];
const STATUSES = [
  'pending', 'content_review', 'waiting_for_raw', 'raw_uploaded', 'editing', 'caption_ready', 'review',
  'changes_requested', 'resolved', 'approved', 'scheduled', 'posted', 'completed', 'rejected', 'cancelled',
];
const REASON_REQUIRED = ['rejected', 'changes_requested', 'cancelled'];

const STATUS_NAMES = {
  pending: 'Content Draft',
  content_review: 'Content Review',
  waiting_for_raw: 'Awaiting Raw Video',
  review: 'Final Review',
};
const statusLabel = (s) => STATUS_NAMES[s] || label(s);
const statusBadge = (s) => badge(s).replace(`>${esc(label(s))}<`, `>${esc(statusLabel(s))}<`);

const VIDEO_TYPES = ['Reel', 'Short', 'Long-form', 'Story', 'Poster', 'Carousel', 'Ad Film', 'Testimonial', 'Interview', 'Other'];
const PROMOTION_TYPES = ['Organic', 'Paid', 'Boosted', 'Collaboration', 'Influencer', 'Contest'];
const CONTENT_CATEGORIES = ['Promotional', 'Educational', 'Entertainment', 'Behind the Scenes', 'Product Showcase', 'Offer / Sale', 'Festival', 'Branding', 'Testimonial', 'News / Update'];
const CHANNEL_STATUSES = ['not_posted', 'scheduled', 'posted', 'failed'];

const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
const todayStr = () => new Date().toLocaleDateString('en-CA');
const taskCode = (id) => `TSK-${String(id).padStart(4, '0')}`;

const page = $('#page');
let clientCache = null;
let teamCache = null;

/* ---------------- shared data helpers ---------------- */

async function getClients(force = false) {
  if (!clientCache || force) {
    const r = await Api.get('/api/clients?limit=100');
    clientCache = r.data;
  }
  return clientCache;
}
const invalidateClients = () => { clientCache = null; };

async function getTeam(force = false) {
  if (!teamCache || force) {
    const r = await Api.get('/api/users?limit=100');
    teamCache = r.data;
  }
  return teamCache;
}

async function clientOptionsHtml(selected, blankLabel = 'All clients') {
  const clients = await getClients();
  return [`<option value="">${esc(blankLabel)}</option>`]
    .concat(clients.map((c) =>
      `<option value="${c.id}" ${Number(selected) === c.id ? 'selected' : ''}>${esc(c.company_name)}</option>`))
    .join('');
}

const platformOptions = (sel) =>
  PLATFORMS.map((p) => `<option value="${p}" ${sel === p ? 'selected' : ''}>${label(p)}</option>`).join('');

const selectOptions = (list, sel, blank = '') =>
  (blank ? [`<option value="">${esc(blank)}</option>`] : [])
    .concat(list.map((v) => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(label(v))}</option>`))
    .join('');

/** Field builders shared by full-page forms. */
const F = {
  input: (name, lbl, val = '', { type = 'text', extra = '', hint = '', ph = '' } = {}) => `
    <div class="field" data-f="${name}"><label>${lbl}</label>
      <input type="${type}" name="${name}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${extra}>
      ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`,
  area: (name, lbl, val = '', { rows = 4, hint = '', ph = '' } = {}) => `
    <div class="field" data-f="${name}"><label>${lbl}</label>
      <textarea name="${name}" rows="${rows}" placeholder="${esc(ph)}">${esc(val ?? '')}</textarea>
      ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`,
  select: (name, lbl, optionsHtml, { hint = '' } = {}) => `
    <div class="field" data-f="${name}"><label>${lbl}</label>
      <select name="${name}">${optionsHtml}</select>
      ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`,
};

const errText = (ex) => (ex.details ? ex.details.map((d) => d.message).join(' · ') : ex.message);

/* ---------------- app namespace + router ---------------- */

const ERP = {
  routes: {},
  register(name, fn) { this.routes[name] = fn; },
  /** Set by pages with unsaved state; return a message to block navigation. */
  guard: null,
  modals: {}, // quick-add modal openers registered by pages.js
};

/** Aliases keep legacy notification links + old bookmarks working. */
const ROUTE_ALIASES = {
  deliverables: 'content',
  tasks: 'content',
  invoice: 'invoice',
};

let currentHash = window.location.hash || '#/dashboard';
let skipGuardOnce = false;

async function route() {
  const rawHash = window.location.hash.replace(/^#\//, '') || 'dashboard';
  const [pathPart, queryPart] = rawHash.split('?');
  const segments = pathPart.split('/');
  const params = new URLSearchParams(queryPart || '');

  // Unsaved-changes guard (Task Workspace sets ERP.guard while dirty).
  if (skipGuardOnce) {
    // This hashchange is our own revert after a declined navigation:
    // keep the current DOM (and its unsaved edits) untouched.
    skipGuardOnce = false;
    currentHash = window.location.hash || '#/dashboard';
    return;
  }
  if (ERP.guard && window.location.hash !== currentHash) {
    const msg = ERP.guard();
    if (msg && !window.confirm(msg)) {
      skipGuardOnce = true;
      window.location.hash = currentHash;
      return;
    }
  }
  ERP.guard = null;
  currentHash = window.location.hash || '#/dashboard';

  let base = segments[0];
  // Poster designers are locked to their own pages (tasks + clients).
  if (user.role === 'poster_designer' && !['poster', 'poster-clients', 'poster-today'].includes(base)) { nav('/poster'); return; }
  $$('#nav a').forEach((a) => a.classList.toggle('active',
    a.dataset.page === base ||
    (base === 'tasks' && a.dataset.page === 'content') ||
    (base === 'deliverables' && a.dataset.page === 'content') ||
    (base === 'invoice' && a.dataset.page === 'payments')));
  window.scrollTo(0, 0);
  $('#sidebar').classList.remove('open');

  try {
    // Task editor: every task opens the simple content+captions popup.
    // #/tasks/new is the create page. (legacy #/deliverables/:id and old /full links
    // both fall through to the popup.)
    if ((base === 'tasks' || base === 'deliverables') && segments[1]) {
      if (segments[1] === 'new') return await ERP.routes['task-new'](params);
      return await ERP.routes['task'](Number(segments[1]), params);
    }
    if (base === 'clients' && segments[1]) {
      if (segments[1] === 'new') return await ERP.routes['client-form'](null, params);
      return await ERP.routes['client-form'](Number(segments[1]), params);
    }
    if (base === 'client-report' && segments[1]) {
      return await ERP.routes['client-report-detail'](Number(segments[1]), params);
    }
    if (base === 'poster-clients' && segments[1]) {
      return await ERP.routes['poster-client-detail'](Number(segments[1]), params);
    }
    if (base === 'invoice' && segments[1]) return await ERP.routes['invoice'](Number(segments[1]));
    const fn = ERP.routes[ROUTE_ALIASES[base] && !segments[1] ? ROUTE_ALIASES[base] : base] || ERP.routes.dashboard;
    await fn(params);
  } catch (ex) {
    page.innerHTML = `<div class="card"><div class="card-body empty">⚠️ ${esc(ex.message)}</div></div>`;
  }
  icons();
}

window.addEventListener('hashchange', () => route());
window.addEventListener('beforeunload', (e) => {
  if (ERP.guard && ERP.guard()) { e.preventDefault(); e.returnValue = ''; }
});

const nav = (hash) => { window.location.hash = hash.replace(/^#/, ''); };

/* ---------------- layout: shell wiring ---------------- */

function initLayout() {
  $('#userName').textContent = user.name;
  $('#userRole').textContent = label(user.role);
  $('#userAvatar').textContent = (user.name || 'A')[0].toUpperCase();
  $('#userEmail').textContent = user.email;
  if (user.role !== 'super_admin') {
    $('#teamLink').style.display = 'none';
    $('#settingsLink').style.display = 'none';
    $('#adminLabel').style.display = 'none';
  }
  // Poster designers get a locked-down shell: only their task list.
  if (user.role === 'poster_designer') {
    $$('#nav a, #nav .nav-label').forEach((el) => { el.style.display = 'none'; });
    const pl = $('#posterLink'); if (pl) { pl.hidden = false; pl.style.display = ''; }
    const pt = $('#posterTodayLink'); if (pt) { pt.hidden = false; pt.style.display = ''; }
    const pc = $('#posterClientsLink'); if (pc) { pc.hidden = false; pc.style.display = ''; }
    const qa = $('#quickAddBtn'); if (qa && qa.parentElement) qa.parentElement.style.display = 'none';
  }

  // Collapsible sidebar: rail mode on desktop (persisted), off-canvas on mobile.
  const app = $('#app');
  if (localStorage.getItem('erp.rail') === '1') app.classList.add('rail');
  $('#railToggle').onclick = () => {
    app.classList.toggle('rail');
    localStorage.setItem('erp.rail', app.classList.contains('rail') ? '1' : '0');
  };
  $('#burger').onclick = (e) => { e.stopPropagation(); $('#sidebar').classList.toggle('open'); };
  page.addEventListener('click', () => $('#sidebar').classList.remove('open'));

  // User menu
  $('#userChip').onclick = (e) => { e.stopPropagation(); $('#userDrop').classList.toggle('open'); closeDrops('userDrop'); };
  $('#logoutBtn').onclick = () => Api.logout();
  $('#changePwBtn').onclick = () => changePasswordModal();

  // Quick Add
  $('#quickAddBtn').onclick = (e) => { e.stopPropagation(); $('#quickAddDrop').classList.toggle('open'); closeDrops('quickAddDrop'); };
  $$('#quickAddDrop .qa-item').forEach((b) => (b.onclick = () => {
    $('#quickAddDrop').classList.remove('open');
    const target = b.dataset.qa;
    if (target.startsWith('/')) nav(target);
    else if (ERP.modals[target]) ERP.modals[target]();
  }));

  // Notifications
  $('#notifBtn').onclick = async (e) => {
    e.stopPropagation();
    closeDrops('notifDrop');
    const drop = $('#notifDrop');
    drop.classList.toggle('open');
    if (drop.classList.contains('open')) await loadNotifList();
  };
  $('#markAllRead').onclick = async (e) => {
    e.stopPropagation();
    await Api.post('/api/notifications/read-all');
    await Promise.all([loadNotifList(), refreshNotifCount()]);
  };
  document.addEventListener('click', () => closeDrops());

  // Global search
  const input = $('#globalSearch');
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(input.value.trim()), 280); });
  input.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault(); input.focus();
    }
  });

  refreshNotifCount();
  refreshSidebarCounts();
  setInterval(refreshNotifCount, 45000);
  setInterval(refreshSidebarCounts, 90000);
  Api.get('/api/ai/status').then((r) => { $('#aiMode').textContent = `AI: ${r.data.openai ? 'live' : 'demo'}`; }).catch(() => {});
}

function closeDrops(except) {
  ['notifDrop', 'userDrop', 'quickAddDrop'].forEach((id) => {
    if (id !== except) $(`#${id}`).classList.remove('open');
  });
  $('#searchResults').classList.remove('open');
}

async function refreshNotifCount() {
  try {
    const r = await Api.get('/api/notifications/unread-count');
    const dot = $('#notifDot');
    dot.style.display = r.data.count > 0 ? 'grid' : 'none';
    dot.textContent = r.data.count > 9 ? '9+' : r.data.count;
  } catch { /* session may have expired */ }
}

async function refreshSidebarCounts() {
  try {
    const [today, approvals] = await Promise.all([
      Api.get('/api/deliverables?due=today&limit=1'),
      Api.get('/api/deliverables?status=content_review,review&limit=1'),
    ]);
    const set = (id, n) => {
      const el = $(`#${id}`);
      el.hidden = !n;
      el.textContent = n > 99 ? '99+' : n;
    };
    set('todayCount', today.pagination.total);
    set('approvalCount', approvals.pagination.total);
  } catch { /* non-critical */ }
}

async function loadNotifList() {
  const r = await Api.get('/api/notifications?limit=12');
  const list = $('#notifList');
  if (!r.data.length) { list.innerHTML = '<div class="empty">No notifications yet</div>'; return; }
  list.innerHTML = r.data.map((n) => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || '')}">
      <div class="n-title">${esc(n.title)}</div>
      <div class="n-body">${esc(n.body || '')}</div>
      <div class="n-time">${timeAgo(n.created_at)}</div>
    </div>`).join('');
  $$('.notif-item', list).forEach((el) => {
    el.onclick = async () => {
      await Api.post(`/api/notifications/${el.dataset.id}/read`).catch(() => {});
      refreshNotifCount();
      if (el.dataset.link) nav(el.dataset.link);
      $('#notifDrop').classList.remove('open');
    };
  });
}

async function runSearch(q) {
  const box = $('#searchResults');
  if (q.length < 2) { box.classList.remove('open'); return; }
  const r = await Api.get(`/api/search?q=${encodeURIComponent(q)}`);
  const { clients, deliverables, captions, payments } = r.data;
  let html = '';
  const group = (title, items, render) => {
    if (!items.length) return;
    html += `<div class="sr-group">${title}</div>` + items.map(render).join('');
  };
  group('Clients', clients, (c) =>
    `<a class="sr-item" href="#/clients?q=${encodeURIComponent(c.company_name)}"><strong>${esc(c.company_name)}</strong> · ${esc(c.contact_person || '')} ${badge(c.status)}</a>`);
  group('Content', deliverables, (d) =>
    `<a class="sr-item" href="#/tasks/${d.id}">${esc(d.title)} <span class="t-sub">· ${esc(d.company_name)} · ${fmtDate(d.due_date)}</span> ${statusBadge(d.status)}</a>`);
  group('Captions', captions, (c) =>
    `<a class="sr-item" href="#/captions?q=${encodeURIComponent(q)}">${esc(String(c.body).slice(0, 70))}… <span class="t-sub">· ${esc(c.company_name)}</span></a>`);
  group('Payments', payments, (p) =>
    `<a class="sr-item" href="#/payments">${esc(p.invoice_no || 'Payment')} · ${esc(p.company_name)} · ${fmtMoney(p.amount)} ${badge(p.status)}</a>`);
  box.innerHTML = html || '<div class="empty">No results</div>';
  box.classList.add('open');
}

function changePasswordModal() {
  const m = modal({
    title: 'Change password',
    body: `
      <div class="field"><label>Current password</label><input type="password" id="cpCur"></div>
      <div class="field"><label>New password</label><input type="password" id="cpNew">
        <div class="hint">Min 8 characters, letters + numbers</div></div>`,
    footer: `<button class="btn btn-outline" data-x>Cancel</button>
             <button class="btn btn-primary" data-y>Update</button>`,
  });
  $('[data-x]', m.foot).onclick = m.close;
  $('[data-y]', m.foot).onclick = async () => {
    try {
      await Api.post('/api/auth/change-password', {
        currentPassword: $('#cpCur').value, newPassword: $('#cpNew').value,
      });
      toastOk('Password changed');
      m.close();
    } catch (ex) { toastErr(ex.message); }
  };
}
