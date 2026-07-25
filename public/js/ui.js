/**
 * UI toolkit — DOM helpers, toasts, modals, badges, tiny canvas charts,
 * calendar renderer. No frameworks; shared by admin + portal shells.
 */
'use strict';

const UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  /* ---------- formatting ---------- */
  const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(String(d).replace(' ', 'T'));
    if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtDateTime = (d) => {
    if (!d) return '—';
    const dt = new Date(String(d).replace(' ', 'T'));
    return dt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const timeAgo = (d) => {
    const dt = new Date(String(d).replace(' ', 'T'));
    const s = Math.floor((Date.now() - dt.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const label = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  /* ---------- status → badge colour ---------- */
  const STATUS_COLOR = {
    pending: 'gray', waiting_for_raw: 'amber', raw_uploaded: 'blue', editing: 'violet',
    caption_ready: 'violet', review: 'amber', changes_requested: 'red', resolved: 'blue',
    approved: 'green', scheduled: 'blue', posted: 'green', completed: 'green',
    rejected: 'red', cancelled: 'gray',
    paid: 'green', partial: 'amber', failed: 'red', refunded: 'gray', overdue: 'red',
    sent: 'amber', draft: 'gray',
    active: 'green', inactive: 'gray', paused: 'amber', churned: 'red',
    not_posted: 'gray',
    low: 'gray', medium: 'blue', high: 'amber', urgent: 'red',
  };
  const badge = (status) =>
    `<span class="badge b-${STATUS_COLOR[status] || 'gray'}">${escapeHtml(label(status))}</span>`;

  /* ---------- toasts ---------- */
  function toast(msg, type = '') {
    let holder = $('#toasts');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'toasts';
      document.body.appendChild(holder);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    holder.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
  const toastOk = (m) => toast(m, 'ok');
  const toastErr = (m) => toast(m, 'err');

  /* ---------- modal ---------- */
  function modal({ title, body, footer, wide = false, onClose }) {
    const back = document.createElement('div');
    back.className = 'modal-back open';
    back.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="m-head"><h3>${escapeHtml(title)}</h3>
          <button class="m-close" aria-label="Close">✕</button></div>
        <div class="m-body"></div>
        ${footer !== null ? '<div class="m-foot"></div>' : ''}
      </div>`;
    const bodyEl = $('.m-body', back);
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    const footEl = $('.m-foot', back);
    if (footEl && footer) {
      if (typeof footer === 'string') footEl.innerHTML = footer;
      else footEl.appendChild(footer);
    }
    const close = () => { back.remove(); if (onClose) onClose(); };
    $('.m-close', back).onclick = close;
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    return { el: back, close, body: bodyEl, foot: footEl };
  }

  function confirmModal(title, message, onYes, danger = true) {
    const m = modal({
      title,
      body: `<p style="font-size:.92rem;color:var(--ink-2)">${escapeHtml(message)}</p>`,
      footer: `<button class="btn btn-outline" data-x>Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-y>Confirm</button>`,
    });
    $('[data-x]', m.foot).onclick = m.close;
    $('[data-y]', m.foot).onclick = async () => { m.close(); await onYes(); };
  }

  /* ---------- tiny canvas charts ---------- */
  const PALETTE = ['#4527a0', '#7c5cd6', '#1e8e5a', '#b26a00', '#1565c0', '#c62838', '#6d28d9', '#9aa0b5'];

  function prepCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = (canvas.dataset.h ? Number(canvas.dataset.h) : rect.height || 220) * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: canvas.height / dpr };
  }

  /** Bar chart: data = [{label, value}] */
  function barChart(canvas, data, { color = PALETTE[0], money = false } = {}) {
    if (!canvas || !data) return;
    const { ctx, w, h } = prepCanvas(canvas);
    const pad = { l: 46, r: 8, t: 12, b: 26 };
    const max = Math.max(...data.map((d) => d.value), 1);
    const cw = (w - pad.l - pad.r) / data.length;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Inter, sans-serif';
    // gridlines
    ctx.strokeStyle = '#eef0f5'; ctx.fillStyle = '#9aa0b5'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      const v = max * (1 - i / 4);
      ctx.fillText(money ? (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0)) : Math.round(v), pad.l - 6, y + 4);
    }
    data.forEach((d, i) => {
      const bh = ((h - pad.t - pad.b) * d.value) / max;
      const x = pad.l + i * cw + cw * 0.2;
      const y = h - pad.b - bh;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, cw * 0.6, bh, 4);
      ctx.fill();
      ctx.fillStyle = '#9aa0b5'; ctx.textAlign = 'center';
      ctx.fillText(d.label, pad.l + i * cw + cw / 2, h - 8);
    });
  }

  /** Line chart: series = [{name, color, points:[{label, value}]}] */
  function lineChart(canvas, series, { money = false } = {}) {
    if (!canvas || !series || !series.length) return;
    const { ctx, w, h } = prepCanvas(canvas);
    const pad = { l: 48, r: 10, t: 12, b: 24 };
    const all = series.flatMap((s) => s.points.map((p) => p.value));
    const max = Math.max(...all, 1);
    const min = Math.min(...all, 0);
    const n = series[0].points.length;
    const xAt = (i) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(n - 1, 1);
    const yAt = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / Math.max(max - min, 1));
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Inter, sans-serif';
    ctx.strokeStyle = '#eef0f5'; ctx.fillStyle = '#9aa0b5'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      const v = max - ((max - min) * i) / 4;
      ctx.fillText(money ? (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0)) : (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)), pad.l - 6, y + 4);
    }
    // x labels (sparse)
    ctx.textAlign = 'center';
    const step = Math.ceil(n / 6);
    series[0].points.forEach((p, i) => {
      if (i % step === 0) ctx.fillText(p.label, xAt(i), h - 6);
    });
    series.forEach((s, si) => {
      ctx.strokeStyle = s.color || PALETTE[si];
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(xAt(i), yAt(p.value)) : ctx.moveTo(xAt(i), yAt(p.value))));
      ctx.stroke();
      // subtle fill for first series
      if (si === 0) {
        ctx.lineTo(xAt(n - 1), h - pad.b); ctx.lineTo(xAt(0), h - pad.b); ctx.closePath();
        ctx.fillStyle = (s.color || PALETTE[0]) + '14';
        ctx.fill();
      }
    });
  }

  /** Donut chart: data = [{label, value}], renders legend beside it. */
  function donutChart(canvas, data, legendEl) {
    if (!canvas || !data || !data.length) return;
    const { ctx, w, h } = prepCanvas(canvas);
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 8;
    let a = -Math.PI / 2;
    ctx.clearRect(0, 0, w, h);
    data.forEach((d, i) => {
      const slice = (d.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a, a + slice);
      ctx.arc(cx, cy, r * 0.62, a + slice, a, true);
      ctx.closePath();
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.fill();
      a += slice;
    });
    ctx.fillStyle = '#1f2333';
    ctx.font = '700 18px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy + 6);
    if (legendEl) {
      legendEl.innerHTML = data.map((d, i) =>
        `<span class="badge" style="background:${PALETTE[i % PALETTE.length]}18;color:${PALETTE[i % PALETTE.length]}">
          ${escapeHtml(d.label)} · ${d.value}</span>`).join(' ');
    }
  }

  /* ---------- calendar ---------- */
  const STATUS_PILL = {
    completed: ['#e5f6ee', '#1e8e5a'], posted: ['#e5f6ee', '#1e8e5a'], approved: ['#e5f6ee', '#1e8e5a'],
    scheduled: ['#e7f0fb', '#1565c0'], raw_uploaded: ['#e7f0fb', '#1565c0'], resolved: ['#e7f0fb', '#1565c0'],
    review: ['#fdf2df', '#b26a00'], waiting_for_raw: ['#fdf2df', '#b26a00'], pending: ['#eef0f5', '#5a607a'],
    editing: ['#f1eafd', '#6d28d9'], caption_ready: ['#f1eafd', '#6d28d9'],
    changes_requested: ['#fde9ec', '#c62838'], rejected: ['#fde9ec', '#c62838'], cancelled: ['#eef0f5', '#5a607a'],
  };

  /**
   * Render a month calendar. items = [{due_date, title, status,...}]
   * onDayClick(dateStr, itemsOfDay)
   */
  function calendar(container, monthStr, items, { mini = false, onDayClick, onNav } = {}) {
    const [y, m] = monthStr.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const todayStr = new Date().toLocaleDateString('en-CA');
    const startDow = first.getDay(); // 0=Sun
    const daysInMonth = new Date(y, m, 0).getDate();
    const byDay = {};
    (items || []).forEach((it) => {
      const key = String(it.due_date).slice(0, 10);
      (byDay[key] = byDay[key] || []).push(it);
    });

    const monthName = first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    let html = `
      <div class="cal-head no-print">
        <button class="btn btn-outline btn-sm" data-nav="-1">‹</button>
        <span class="cal-title">${monthName}</span>
        <button class="btn btn-outline btn-sm" data-nav="1">›</button>
      </div>
      <div class="cal-grid ${mini ? 'cal-mini' : ''}">`;
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => (html += `<div class="cal-dow">${d}</div>`));
    for (let i = 0; i < startDow; i++) html += '<div class="cal-cell other"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
      const dayItems = byDay[dateStr] || [];
      const maxShow = mini ? 1 : 3;
      html += `<div class="cal-cell ${dateStr === todayStr ? 'today' : ''}" data-date="${dateStr}">
        <div class="c-day">${day}</div>`;
      dayItems.slice(0, maxShow).forEach((it) => {
        const [bg, fg] = STATUS_PILL[it.status] || STATUS_PILL.pending;
        html += `<span class="cal-pill" style="background:${bg};color:${fg}" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>`;
      });
      if (dayItems.length > maxShow) html += `<span class="cal-more">+${dayItems.length - maxShow} more</span>`;
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;

    $$('.cal-cell[data-date]', container).forEach((cell) => {
      cell.onclick = () => onDayClick && onDayClick(cell.dataset.date, byDay[cell.dataset.date] || []);
    });
    $$('[data-nav]', container).forEach((btn) => {
      btn.onclick = () => {
        const delta = Number(btn.dataset.nav);
        const next = new Date(y, m - 1 + delta, 1);
        const nextStr = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
        onNav && onNav(nextStr);
      };
    });
  }

  /**
   * Weekly calendar (agenda columns). refStr = any 'YYYY-MM-DD' in the week.
   * onNav(newRefStr) fires on prev/next; onDayClick(dateStr, items) on a column.
   */
  function calendarWeek(container, refStr, items, { onNav, onDayClick } = {}) {
    const ref = new Date(`${refStr}T00:00:00`);
    if (Number.isNaN(ref.getTime())) return;
    const start = new Date(ref);
    start.setDate(ref.getDate() - ref.getDay()); // back to Sunday
    const todayStr = new Date().toLocaleDateString('en-CA');
    const byDay = {};
    (items || []).forEach((it) => {
      const k = String(it.due_date).slice(0, 10);
      (byDay[k] = byDay[k] || []).push(it);
    });

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    const end = days[6];
    const rangeLabel = `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = `
      <div class="cal-head no-print">
        <button class="btn btn-outline btn-sm" data-week="-1">‹</button>
        <span class="cal-title">${rangeLabel}</span>
        <button class="btn btn-outline btn-sm" data-week="1">›</button>
      </div>
      <div class="week-grid">`;
    days.forEach((d, i) => {
      const ds = d.toLocaleDateString('en-CA');
      const dayItems = byDay[ds] || [];
      html += `<div class="week-col ${ds === todayStr ? 'today' : ''}" data-date="${ds}">
        <div class="week-col-head">${dow[i]} <strong>${d.getDate()}</strong></div>`;
      dayItems.forEach((it) => {
        const [bg, fg] = STATUS_PILL[it.status] || STATUS_PILL.pending;
        html += `<span class="cal-pill" style="background:${bg};color:${fg}" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>`;
      });
      if (!dayItems.length) html += '<span class="cal-more">—</span>';
      html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;

    $$('.week-col[data-date]', container).forEach((col) => {
      col.onclick = () => onDayClick && onDayClick(col.dataset.date, byDay[col.dataset.date] || []);
    });
    $$('[data-week]', container).forEach((btn) => {
      btn.onclick = () => {
        const next = new Date(start);
        next.setDate(start.getDate() + Number(btn.dataset.week) * 7);
        onNav && onNav(next.toLocaleDateString('en-CA'));
      };
    });
  }

  /** Pagination footer renderer. */
  function pager(container, pagination, onPage) {
    if (!pagination || pagination.pages <= 1) { container.innerHTML = ''; return; }
    const { page, pages, total } = pagination;
    container.innerHTML = `
      <span>Page ${page} of ${pages} · ${fmtNum(total)} records</span>
      <span class="pg-btns">
        <button class="btn btn-outline btn-sm" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <button class="btn btn-outline btn-sm" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>
      </span>`;
    $$('button[data-p]', container).forEach((b) => (b.onclick = () => onPage(Number(b.dataset.p))));
  }

  /** Refresh Lucide icons after DOM updates (safe if CDN unavailable). */
  function icons() {
    if (window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch { /* noop */ }
    }
  }

  const scoreColor = (s) => (s >= 80 ? 'var(--green)' : s >= 60 ? 'var(--amber)' : 'var(--red)');

  /* ---------- global event delegation (CSP-safe, no inline handlers) ----
   * Only treat data-nav values that look like routes ("/x" or "#/x") as
   * navigation. Non-route values (e.g. the calendar's "1" / "-1" month
   * arrows) are handled by their own local onclick, so they are ignored here
   * to avoid hijacking them into location.hash. */
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav && /^[#/]/.test(nav.dataset.nav || '')) {
      $$('.modal-back').forEach((m) => m.remove());
      window.location.hash = nav.dataset.nav.replace(/^#/, '');
      return;
    }
    if (e.target.closest('.js-print')) window.print();
  });

  return {
    $, $$, escapeHtml, fmtMoney, fmtNum, fmtDate, fmtDateTime, timeAgo, label, badge,
    toast, toastOk, toastErr, modal, confirmModal,
    barChart, lineChart, donutChart, calendar, calendarWeek, pager, icons, scoreColor, PALETTE,
  };
})();
