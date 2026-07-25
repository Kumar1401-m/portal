/**
 * Client Portal SPA — dashboard, calendar, content review workflow,
 * payments (Razorpay), analytics and reports for a single client.
 * Note: no inline event handlers anywhere (strict CSP) — navigation uses
 * data-nav attributes handled by the global delegate in ui.js.
 */
'use strict';

const {
  $, $$, escapeHtml: esc, fmtMoney, fmtNum, fmtDate, fmtDateTime, timeAgo, label, badge,
  toastOk, toastErr, modal, confirmModal, lineChart, calendar, pager, icons, scoreColor,
} = UI;

const user = Api.getUser();
if (!user || user.role !== 'client') window.location.href = '/';

const page = $('#page');
const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);

/* ---------------- layout ---------------- */

function initLayout() {
  $('#userName').textContent = user.name;
  $('#userAvatar').textContent = (user.name || 'C')[0].toUpperCase();
  $('#userEmail').textContent = user.email;
  $('#burger').onclick = () => $('#sidebar').classList.toggle('open');
  page.addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#userChip').onclick = (e) => { e.stopPropagation(); $('#userDrop').classList.toggle('open'); $('#notifDrop').classList.remove('open'); };
  $('#logoutBtn').onclick = () => Api.logout();
  $('#notifBtn').onclick = async (e) => {
    e.stopPropagation();
    $('#userDrop').classList.remove('open');
    const drop = $('#notifDrop');
    drop.classList.toggle('open');
    if (drop.classList.contains('open')) await loadNotifList();
  };
  $('#markAllRead').onclick = async (e) => {
    e.stopPropagation();
    await Api.post('/api/notifications/read-all');
    await Promise.all([loadNotifList(), refreshNotifCount()]);
  };
  document.addEventListener('click', () => {
    $('#notifDrop').classList.remove('open');
    $('#userDrop').classList.remove('open');
  });
  refreshNotifCount();
  setInterval(refreshNotifCount, 45000);

  Api.get('/api/auth/me').then((r) => {
    if (r.data.company) $('#brandName').textContent = r.data.company.company_name;
  }).catch(() => {});
}

async function refreshNotifCount() {
  try {
    const r = await Api.get('/api/notifications/unread-count');
    const dot = $('#notifDot');
    dot.style.display = r.data.count > 0 ? 'grid' : 'none';
    dot.textContent = r.data.count > 9 ? '9+' : r.data.count;
  } catch { /* ignore */ }
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
      if (el.dataset.link) window.location.hash = el.dataset.link.replace(/^#/, '');
      $('#notifDrop').classList.remove('open');
    };
  });
}

/* ---------------- router ---------------- */

const routes = {
  dashboard: renderDashboard,
  calendar: renderCalendar,
  content: renderContent,
  payments: renderPayments,
  reports: renderReports,
};

async function route() {
  const hash = window.location.hash.replace(/^#\//, '') || 'dashboard';
  const [pathPart, queryPart] = hash.split('?');
  const segments = pathPart.split('/');
  const params = new URLSearchParams(queryPart || '');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === segments[0]));
  window.scrollTo(0, 0);
  try {
    if (segments[0] === 'content' && segments[1]) return await renderContentDetail(Number(segments[1]));
    if (segments[0] === 'invoice' && segments[1]) return await renderInvoice(Number(segments[1]));
    await (routes[segments[0]] || renderDashboard)(params);
  } catch (ex) {
    page.innerHTML = `<div class="card"><div class="card-body empty">⚠️ ${esc(ex.message)}</div></div>`;
  }
  icons();
}
window.addEventListener('hashchange', route);

/* ============ DASHBOARD ============ */
async function renderDashboard() {
  page.innerHTML = '<div class="empty">Loading…</div>';
  const r = await Api.get('/api/dashboard/client');
  const d = r.data;
  if (!d || !d.client) {
    page.innerHTML = '<div class="card"><div class="card-body empty">Your portal is not linked to a client profile yet. Please contact the agency.</div></div>';
    return;
  }
  const m = d.month || {};
  const planned = Number(m.planned || 0);
  const completed = Number(m.completed || 0);
  const pct = planned ? Math.round((completed / planned) * 100) : 0;

  const stat = (icon, val, lbl, color) => `
    <div class="stat">
      <div class="s-icon" style="background:${color}18;color:${color}"><i data-lucide="${icon}"></i></div>
      <div><div class="s-val">${val}</div><div class="s-label">${lbl}</div></div>
    </div>`;

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Hello, ${esc(user.name.split(' ')[0])} 👋</h1>
        <div class="sub">${esc(d.client.company_name)} · ${esc(d.client.monthly_package || 'Custom plan')}${d.client.renewal_date ? ' · renews ' + fmtDate(d.client.renewal_date) : ''}</div></div>
    </div>

    <div class="grid stats-grid" style="margin-bottom:16px">
      ${stat('clapperboard', fmtNum(planned), 'Planned this month', '#4527a0')}
      ${stat('circle-check', fmtNum(completed), 'Completed', '#1e8e5a')}
      ${stat('send', fmtNum(m.posted || 0), 'Posted', '#1565c0')}
      ${stat('upload', fmtNum(m.waiting_raw || 0), 'Waiting for your raw files', '#b26a00')}
      ${stat('wallet', fmtMoney(d.payments.due), 'Amount due', '#c62838')}
    </div>

    <div class="grid grid-23">
      <div class="card">
        <div class="card-head"><h3>Waiting for your approval</h3><a class="link-btn" href="#/content?approval=pending">See all</a></div>
        <div class="card-body flush" id="awaitList"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card">
          <div class="card-head"><h3>Month progress</h3></div>
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;font-size:.86rem;margin-bottom:6px">
              <span>${completed} of ${planned} deliverables</span><strong>${pct}%</strong></div>
            <div class="progress"><div style="width:${pct}%"></div></div>
            ${d.payments.due > 0 ? `<div class="divider"></div>
              <div style="font-size:.87rem;margin-bottom:8px">You have <strong style="color:var(--red)">${fmtMoney(d.payments.due)}</strong> pending.</div>
              <a class="btn btn-primary btn-sm" href="#/payments">Pay now</a>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Recent notifications</h3></div>
          <div class="card-body flush" id="dashNotifs"></div>
        </div>
      </div>
    </div>`;

  $('#awaitList').innerHTML = d.awaiting_approval.length ? d.awaiting_approval.map((a) => `
    <div class="notif-item" style="cursor:pointer" data-nav="/content/${a.id}">
      <div class="n-title">${esc(a.title)} ${badge(a.status)}</div>
      <div class="n-body">${label(a.platform)} · due ${fmtDate(a.due_date)}</div>
    </div>`).join('') : '<div class="empty">🎉 Nothing waiting for approval</div>';

  $('#dashNotifs').innerHTML = (d.notifications || []).length ? d.notifications.slice(0, 5).map((n) => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}">
      <div class="n-title">${esc(n.title)}</div>
      <div class="n-time">${timeAgo(n.created_at)}</div>
    </div>`).join('') : '<div class="empty">No notifications</div>';
}

/* ============ CALENDAR ============ */
async function renderCalendar(params) {
  const month = params.get('month') || thisMonth();
  page.innerHTML = `
    <div class="page-head"><div><h1>Content Calendar</h1><div class="sub">Your assigned dates and content plan</div></div></div>
    <div class="card"><div class="card-body"><div id="cal"></div></div></div>`;
  const r = await Api.get(`/api/deliverables/calendar?month=${month}`);
  calendar($('#cal'), month, r.data.items, {
    onNav: (next) => { window.location.hash = `/calendar?month=${next}`; },
    onDayClick: (date, items) => {
      modal({
        title: `Content — ${fmtDate(date)}`,
        body: items.length ? items.map((it) => `
          <div class="notif-item" style="cursor:pointer" data-nav="/content/${it.id}">
            <div class="n-title">${esc(it.title)} ${badge(it.status)}</div>
            <div class="n-body">${label(it.platform)}</div>
          </div>`).join('') : '<div class="empty">Nothing planned this day</div>',
        footer: null,
      });
    },
  });
}

/* ============ CONTENT LIST ============ */
async function renderContent(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head"><div><h1>My Content</h1><div class="sub">Upload raw files, review edits, approve or request changes</div></div></div>
    <div class="filters">
      <select id="fStatus"><option value="">All statuses</option>
        ${['content_review', 'waiting_for_raw', 'raw_uploaded', 'editing', 'review', 'approved', 'scheduled', 'posted', 'completed']
          .map((s) => `<option value="${s}" ${params.get('status') === s ? 'selected' : ''}>${label(s)}</option>`).join('')}
      </select>
      <input type="month" id="fMonth" value="${esc(params.get('month') || '')}" />
      ${params.get('approval') === 'pending' ? '<span class="badge b-amber">Showing: awaiting your approval</span>' : ''}
    </div>
    <div class="card"><div class="card-body flush table-wrap" id="contentTable"></div><div class="pager" id="contentPager"></div></div>`;

  const apply = () => {
    const p = new URLSearchParams();
    if ($('#fStatus').value) p.set('status', $('#fStatus').value);
    if ($('#fMonth').value) p.set('month', $('#fMonth').value);
    window.location.hash = `/content?${p}`;
  };
  $('#fStatus').onchange = apply;
  $('#fMonth').onchange = apply;

  const qs = new URLSearchParams({ page: pageNo, limit: 20 });
  ['status', 'month', 'approval'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });
  const r = await Api.get(`/api/deliverables?${qs}`);

  $('#contentTable').innerHTML = r.data.length ? `
    <table class="tbl"><thead><tr><th>Content</th><th>Platform</th><th>Due date</th><th>Status</th><th>Action needed</th><th>Open</th></tr></thead>
    <tbody>${r.data.map((d) => {
      let action = '—';
      if (d.status === 'content_review') action = '<span class="badge b-blue">Review content</span>';
      else if (d.status === 'waiting_for_raw') action = '<span class="badge b-amber">Upload raw video</span>';
      else if (d.status === 'review') action = '<span class="badge b-blue">Approve final video</span>';
      return `<tr class="clickable" data-nav="/content/${d.id}">
        <td class="t-main">${esc(d.title)}</td>
        <td><span class="badge b-primary">${label(d.platform)}</span></td>
        <td>${fmtDate(d.due_date)}</td>
        <td>${badge(d.status)}</td>
        <td>${action}</td>
        <td class="row-actions"><span class="iconbtn" title="Open" style="color:var(--primary)"><i data-lucide="pencil"></i></span></td>
      </tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">No content found</div>';

  pager($('#contentPager'), r.pagination, (p) => { qs.set('page', p); window.location.hash = `/content?${qs}`; });
}

/* ============ CONTENT DETAIL ============ */
async function renderContentDetail(id) {
  page.innerHTML = '<div class="empty">Loading…</div>';
  const r = await Api.get(`/api/deliverables/${id}`);
  const d = r.data;
  // Two gates: 'content' (approve the idea/script before filming) and 'final'
  // (approve the finished, captioned video before posting).
  const gate = d.status === 'content_review' ? 'content' : d.status === 'review' ? 'final' : null;
  const canUploadRaw = ['waiting_for_raw', 'raw_uploaded'].includes(d.status);
  const reviewCopy = gate === 'content'
    ? { h: 'Review the content', p: 'Read the content below. Approve it to let us start filming, or tell us what to change.', ok: 'Approve Content' }
    : { h: 'Review the final video', p: 'Happy with the final video? Approve it for posting, or tell us what to change.', ok: 'Approve for Posting' };

  page.innerHTML = `
    <div class="page-head">
      <div>
        <a class="link-btn" href="#/content">← Back to my content</a>
        <h1 style="margin-top:4px">${esc(d.title)}</h1>
        <div class="sub">${label(d.platform)} · due ${fmtDate(d.due_date)}</div>
      </div>
      <div class="head-actions">${badge(d.status)}</div>
    </div>

    <div class="grid grid-23">
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card"><div class="card-head"><h3>Content</h3></div>
          <div class="card-body">
            ${d.content_hook
              ? `<div class="k" style="margin-bottom:4px">What's in the video</div><div class="copy-box">${esc(d.content_hook)}</div>`
              : '<p style="font-size:.86rem;color:var(--ink-2)">The agency is preparing the content for this item.</p>'}
          </div></div>

        ${d.edited_link ? `
        <div class="card"><div class="card-head"><h3>Video</h3></div>
          <div class="card-body">
            <p style="font-size:.86rem;color:var(--ink-2);margin-bottom:12px">Your edited video is ready — open it to watch.</p>
            <a class="btn btn-primary" href="${esc(d.edited_link)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> Open Video</a>
          </div></div>` : ''}

        ${canUploadRaw ? `
        <div class="card">
          <div class="card-head"><h3>Raw video (Google Drive)</h3></div>
          <div class="card-body">
            ${d.status === 'waiting_for_raw'
              ? '<p style="font-size:.88rem;color:var(--green);font-weight:600;margin-bottom:10px">✓ Content approved — now upload your raw video so our editors can start.</p>'
              : ''}
            ${d.raw_drive_link
              ? `<div class="kv"><span class="k">Uploaded link</span><span class="v"><a href="${esc(d.raw_drive_link)}" target="_blank" rel="noopener">Open ↗</a></span></div>`
              : '<p style="font-size:.88rem;color:var(--ink-2);margin-bottom:10px">Paste your Google Drive share link so our editors can start.</p>'}
            <div class="field" style="margin-top:10px"><label>${d.raw_drive_link ? 'Replace link' : 'Google Drive link'}</label>
              <input id="rawInput" placeholder="https://drive.google.com/file/d/…"></div>
            <button class="btn btn-primary" id="uploadRaw"><i data-lucide="upload"></i> Save Raw Link</button>
          </div>
        </div>` : ''}

        ${d.caption ? `
        <div class="card"><div class="card-head"><h3>Caption</h3>
          <button class="link-btn" id="copyCap">Copy</button></div>
          <div class="card-body"><div class="copy-box">${esc(d.caption)}</div></div></div>` : ''}

      </div>

      <div style="display:flex;flex-direction:column;gap:16px">
        ${gate ? `
        <div class="card">
          <div class="card-head"><h3>${reviewCopy.h}</h3></div>
          <div class="card-body">
            <p style="font-size:.86rem;color:var(--ink-2);margin-bottom:12px">${reviewCopy.p}</p>
            <button class="btn btn-green" id="approveBtn" style="width:100%;justify-content:center;margin-bottom:8px">
              <i data-lucide="check"></i> ${reviewCopy.ok}</button>
            <button class="btn btn-outline" id="changesBtn" style="width:100%;justify-content:center">
              <i data-lucide="message-square-warning"></i> Request Changes</button>
          </div>
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h3>Status</h3></div>
          <div class="card-body">
            <div class="kv"><span class="k">Workflow</span><span class="v">${badge(d.status)}</span></div>
            <div class="kv"><span class="k">Your approval</span><span class="v">${badge(d.approval_status)}</span></div>
            <div class="kv"><span class="k">Posting</span><span class="v">${badge(d.posting_status)}</span></div>
            ${d.posted_at ? `<div class="kv"><span class="k">Posted at</span><span class="v">${fmtDateTime(d.posted_at)}</span></div>` : ''}
            ${d.reject_reason ? `<div class="divider"></div><div style="font-size:.85rem"><strong>Last note:</strong> ${esc(d.reject_reason)}</div>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  const uploadRaw = $('#uploadRaw');
  if (uploadRaw) uploadRaw.onclick = async () => {
    const link = $('#rawInput').value.trim();
    if (!link) return toastErr('Paste your Google Drive link first');
    try {
      const res = await Api.post(`/api/deliverables/${d.id}/raw-link`, { link });
      toastOk(res.message);
      route();
    } catch (ex) { toastErr(ex.message); }
  };

  const copyBtn = $('#copyCap');
  if (copyBtn) copyBtn.onclick = () => navigator.clipboard.writeText(d.caption).then(() => toastOk('Caption copied'));

  const approveBtn = $('#approveBtn');
  if (approveBtn) approveBtn.onclick = () =>
    confirmModal(reviewCopy.h, gate === 'content'
      ? 'Approve this content so we can start filming?'
      : 'Approve this final video for posting?', async () => {
      await Api.post(`/api/deliverables/${d.id}/status`, { status: 'approved' });
      toastOk(gate === 'content' ? 'Content approved — thank you!' : 'Approved — the agency has been notified');
      route();
    }, false);

  const changesBtn = $('#changesBtn');
  if (changesBtn) changesBtn.onclick = () => {
    const m = modal({
      title: 'Request changes',
      body: `<div class="field"><label>What should we change? *</label>
        <textarea id="chReason" rows="4" placeholder="Describe the changes you need…"></textarea></div>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button>
               <button class="btn btn-primary" data-y>Send Request</button>`,
    });
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = async () => {
      const reason = $('#chReason').value.trim();
      if (!reason) return toastErr('Please describe the changes');
      await Api.post(`/api/deliverables/${d.id}/status`, { status: 'changes_requested', reason });
      toastOk('Change request sent');
      m.close();
      route();
    };
  };
  icons(); // opened via a direct route, so render icons here too
}

/* ============ PAYMENTS ============ */
async function renderPayments(params) {
  const pageNo = Number(params.get('page') || 1);
  page.innerHTML = `
    <div class="page-head"><div><h1>Payments & Invoices</h1><div class="sub">Pay online, download invoices, view history</div></div></div>
    <div class="grid grid-2" style="margin-bottom:16px" id="payStats"></div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Invoices</h3></div>
      <div class="card-body flush table-wrap" id="invTable"></div></div>
    <div class="card"><div class="card-head"><h3>Payment history</h3></div>
      <div class="card-body flush table-wrap" id="histTable"></div><div class="pager" id="histPager"></div></div>`;

  const [invRes, payRes] = await Promise.all([
    Api.get('/api/payments/invoices?limit=50'),
    Api.get(`/api/payments?page=${pageNo}&limit=10`),
  ]);

  const due = invRes.data.filter((i) => ['sent', 'overdue'].includes(i.status))
    .reduce((s, i) => s + Number(i.total), 0);
  const paid = payRes.data.filter((p) => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  $('#payStats').innerHTML = `
    <div class="stat"><div class="s-icon" style="background:#c6283818;color:#c62838"><i data-lucide="wallet"></i></div>
      <div><div class="s-val">${fmtMoney(due)}</div><div class="s-label">Amount due</div></div></div>
    <div class="stat"><div class="s-icon" style="background:#1e8e5a18;color:#1e8e5a"><i data-lucide="badge-check"></i></div>
      <div><div class="s-val">${fmtMoney(paid)}</div><div class="s-label">Paid (recent)</div></div></div>`;

  $('#invTable').innerHTML = invRes.data.length ? `
    <table class="tbl"><thead><tr><th>Invoice</th><th>Period</th><th class="num">Total</th><th>Due</th><th>Status</th><th></th></tr></thead>
    <tbody>${invRes.data.map((i) => `
      <tr>
        <td class="t-main">${esc(i.invoice_no)}</td>
        <td>${esc(i.period_month || '—')}</td>
        <td class="num">${fmtMoney(i.total)}</td>
        <td>${fmtDate(i.due_date)}</td>
        <td>${badge(i.status)}</td>
        <td style="white-space:nowrap">
          ${['sent', 'overdue'].includes(i.status) ? `<button class="btn btn-primary btn-sm" data-pay="${i.id}">Pay Online</button>` : ''}
          <a class="btn btn-outline btn-sm" href="#/invoice/${i.id}">Invoice</a>
        </td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No invoices yet</div>';

  $$('[data-pay]').forEach((b) => (b.onclick = () => startPayment(Number(b.dataset.pay))));

  $('#histTable').innerHTML = payRes.data.length ? `
    <table class="tbl"><thead><tr><th>Date</th><th>Invoice</th><th class="num">Amount</th><th>Method</th><th>Status</th></tr></thead>
    <tbody>${payRes.data.map((p) => `
      <tr>
        <td>${p.paid_at ? fmtDateTime(p.paid_at) : fmtDate(p.created_at)}</td>
        <td>${esc(p.invoice_no || '—')}</td>
        <td class="num">${fmtMoney(p.amount)}</td>
        <td>${esc(p.method || '—')}</td>
        <td>${badge(p.status)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No payments yet</div>';
  pager($('#histPager'), payRes.pagination, (p) => { window.location.hash = `/payments?page=${p}`; });
}

async function startPayment(invoiceId) {
  try {
    const res = await Api.post('/api/payments/order', { invoice_id: invoiceId });
    const o = res.data;

    if (o.mock || !window.Razorpay) {
      // Demo mode — simulate a successful checkout.
      confirmModal(
        'Demo payment',
        `Razorpay keys are not configured, so this is a simulated payment of ${fmtMoney(o.amount / 100)} for ${o.invoice_no}. Mark it as paid?`,
        async () => {
          await Api.post('/api/payments/verify', { razorpay_order_id: o.order_id });
          toastOk('Payment recorded (demo mode)');
          route();
        }, false
      );
      return;
    }

    const rzp = new window.Razorpay({
      key: o.key_id,
      amount: o.amount,
      currency: o.currency,
      name: 'Agency ERP',
      description: `Invoice ${o.invoice_no}`,
      order_id: o.order_id,
      prefill: { email: user.email, name: user.name },
      theme: { color: '#4527a0' },
      handler: async (resp) => {
        try {
          await Api.post('/api/payments/verify', resp);
          toastOk('Payment successful — thank you!');
          route();
        } catch (ex) { toastErr(ex.message); }
      },
    });
    rzp.open();
  } catch (ex) { toastErr(ex.message); }
}

/* ============ INVOICE (printable) ============ */
async function renderInvoice(id) {
  const r = await Api.get(`/api/payments/invoices/${id}`);
  const inv = r.data;
  const ag = inv.agency || {};
  const items = (typeof inv.line_items === 'string' ? JSON.parse(inv.line_items || '[]') : inv.line_items) || [];
  page.innerHTML = `
    <div class="page-head no-print">
      <a class="link-btn" href="#/payments">← Back to payments</a>
      <div class="head-actions"><button class="btn btn-primary js-print"><i data-lucide="printer"></i> Download / Print</button></div>
    </div>
    <div class="card" style="max-width:760px;margin:0 auto"><div class="card-body" style="padding:34px">
      <div style="display:flex;justify-content:space-between;margin-bottom:26px">
        <div>
          ${ag.logo ? `<img src="${esc(ag.logo)}" alt="logo" style="height:38px;border-radius:8px;margin-bottom:6px">` : ''}
          <strong style="font-size:1.15rem;color:var(--primary)">${esc(ag.name || 'Agency ERP')}</strong>
          <div class="t-sub">${esc(ag.address || 'Digital Marketing Services')}</div>
          <div class="t-sub">${[ag.email, ag.contact].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div style="text-align:right">
          <h2 style="color:var(--primary)">INVOICE</h2>
          <div><strong>${esc(inv.invoice_no)}</strong></div>
          <div class="t-sub">Issued ${fmtDate(inv.issue_date)} · Due ${fmtDate(inv.due_date)}</div>
          <div style="margin-top:6px">${badge(inv.status)}</div>
        </div>
      </div>
      <div style="margin-bottom:20px">
        <div class="t-sub" style="text-transform:uppercase;font-size:.7rem;letter-spacing:.05em">Billed to</div>
        <strong>${esc(inv.company_name)}</strong>
      </div>
      <table class="tbl" style="margin-bottom:18px"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${items.map((it) => `<tr><td>${esc(it.description)}</td><td class="num">${it.qty}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${fmtMoney(it.qty * it.rate)}</td></tr>`).join('')}</tbody></table>
      <div style="max-width:280px;margin-left:auto">
        <div class="kv"><span class="k">Subtotal</span><span class="v">${fmtMoney(inv.amount)}</span></div>
        ${Number(inv.tax) > 0 ? `<div class="kv"><span class="k">Tax (GST)</span><span class="v">${fmtMoney(inv.tax)}</span></div>` : ''}
        ${Number(inv.processing_fee) > 0 ? `<div class="kv"><span class="k">Processing fee</span><span class="v">${fmtMoney(inv.processing_fee)}</span></div>` : ''}
        <div class="kv" style="border:none"><span class="k" style="font-weight:700">Total</span>
          <span class="v" style="font-size:1.15rem;color:var(--primary)">${fmtMoney(inv.total)}</span></div>
      </div>
      <div class="t-sub" style="text-align:center;margin-top:16px;color:var(--ink-3)">${esc(ag.powered_by || 'Powered by Venkat')}</div>
    </div></div>`;
}

/* ============ ANALYTICS ============ */
async function renderAnalytics() {
  page.innerHTML = '<div class="empty">Loading analytics…</div>';
  const r = await Api.get('/api/analytics/overview?days=30');
  const { summary, series, best_content: best, comparisons: cmp } = r.data;
  if (!summary) {
    page.innerHTML = '<div class="card"><div class="card-body empty">Analytics will appear here once your accounts are connected.</div></div>';
    return;
  }
  const stat = (lbl, val) => `<div class="stat"><div><div class="s-val">${val}</div><div class="s-label">${lbl}</div></div></div>`;
  const trend = (pct) => pct === null ? '' :
    `<span class="s-trend ${pct >= 0 ? 'trend-up' : 'trend-down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;

  page.innerHTML = `
    <div class="page-head"><div><h1>Analytics</h1><div class="sub">Your social media performance — last 30 days</div></div></div>
    <div class="grid stats-grid" style="margin-bottom:16px">
      ${stat('Followers', fmtNum(summary.followers))}
      ${stat('Follower growth (30d)', '+' + fmtNum(summary.follower_growth))}
      ${stat('Reach', fmtNum(summary.reach))}
      ${stat('Impressions', fmtNum(summary.impressions))}
      ${stat('Likes', fmtNum(summary.likes))}
      ${stat('Comments', fmtNum(summary.comments))}
      ${stat('Shares', fmtNum(summary.shares))}
      ${stat('Saves', fmtNum(summary.saves))}
      ${stat('Engagement rate', summary.engagement_rate + '%')}
    </div>
    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card"><div class="card-head"><h3>Follower growth</h3></div>
        <div class="card-body"><canvas id="chF" data-h="220" style="width:100%"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Daily reach</h3></div>
        <div class="card-body"><canvas id="chR" data-h="220" style="width:100%"></canvas></div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Weekly vs monthly</h3></div>
        <div class="card-body">
          <div class="kv"><span class="k">This week's reach</span><span class="v">${fmtNum(cmp.weekly.current)} ${trend(cmp.weekly.change_pct)}</span></div>
          <div class="kv"><span class="k">This month's reach</span><span class="v">${fmtNum(cmp.monthly.current)} ${trend(cmp.monthly.change_pct)}</span></div>
        </div></div>
      <div class="card"><div class="card-head"><h3>Best performing content</h3></div>
        <div class="card-body flush">${best.length ? best.map((b) => `
          <div class="notif-item" style="cursor:pointer" data-nav="/content/${b.id}">
            <div class="n-title">${esc(b.title)}</div>
            <div class="n-body">${label(b.platform)} ${b.ai_score ? `· quality ${b.ai_score}/100` : ''}</div>
          </div>`).join('') : '<div class="empty">No posted content yet</div>'}</div></div>
    </div>`;

  lineChart($('#chF'), [{ name: 'Followers', color: '#4527a0', points: series.map((s) => ({ label: String(s.snapshot_date).slice(5), value: Number(s.followers) })) }]);
  lineChart($('#chR'), [{ name: 'Reach', color: '#1565c0', points: series.map((s) => ({ label: String(s.snapshot_date).slice(5), value: Number(s.reach) })) }]);
}

/* ============ REPORTS ============ */
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCSV(filename, headers, rows) {
  const lines = [headers.map((h) => csvCell(label(h))).join(',')]
    .concat(rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function renderReports(params) {
  const month = params.get('month') || thisMonth();
  const type = params.get('type') || 'monthly';
  page.innerHTML = `
    <div class="page-head">
      <div><h1>Reports</h1><div class="sub">Monthly delivery and promotion summaries</div></div>
      <div class="head-actions no-print">
        <button class="btn btn-primary" id="rDownload"><i data-lucide="download"></i> Download CSV</button>
        <button class="btn btn-outline js-print"><i data-lucide="printer"></i> Print</button>
      </div>
    </div>
    <div class="filters no-print">
      <select id="rType">
        ${['monthly', 'promotion', 'payment'].map((tp) => `<option value="${tp}" ${type === tp ? 'selected' : ''}>${label(tp)} report</option>`).join('')}
      </select>
      <input type="month" id="rMonth" value="${month}" />
    </div>
    <div class="card"><div class="card-head"><h3 id="rTitle">…</h3><span class="t-sub" id="rSummary"></span></div>
      <div class="card-body flush table-wrap" id="rTable"></div></div>`;

  const apply = () => { window.location.hash = `/reports?type=${$('#rType').value}&month=${$('#rMonth').value}`; };
  $('#rType').onchange = apply;
  $('#rMonth').onchange = apply;

  const r = await Api.get(`/api/reports/${type}?month=${month}`);
  $('#rTitle').textContent = r.data.title;
  $('#rSummary').textContent = Object.entries(r.data.summary || {}).map(([k, v]) => `${label(k)}: ${fmtNum(v)}`).join(' · ');
  const rows = r.data.rows || [];
  if (!rows.length) {
    $('#rTable').innerHTML = '<div class="empty">No data for this month</div>';
    $('#rDownload').disabled = true;
    return;
  }
  const headers = Object.keys(rows[0]).filter((h) => !['raw_drive_link', 'edited_link'].includes(h));
  $('#rTable').innerHTML = `
    <table class="tbl"><thead><tr>${headers.map((h) => `<th>${label(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${headers.map((h) => {
      const v = row[h];
      if (h.includes('status')) return `<td>${badge(v)}</td>`;
      if (h.includes('date') || h.includes('_at')) return `<td>${fmtDate(v)}</td>`;
      if (h === 'amount') return `<td>${fmtMoney(v)}</td>`;
      return `<td>${esc(v ?? '—')}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;

  $('#rDownload').onclick = () => downloadCSV(`${type}-report-${month}.csv`, headers, rows);
}

/* ---------------- boot ---------------- */
initLayout();
route();
