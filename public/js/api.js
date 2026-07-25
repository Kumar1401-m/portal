/**
 * API client — fetch wrapper with JWT bearer auth, automatic token refresh,
 * and consistent error handling.
 */
'use strict';

const Api = (() => {
  const store = () => (localStorage.getItem('remember') === '1' ? localStorage : sessionStorage);

  const getToken = () => store().getItem('accessToken');
  const getRefresh = () => store().getItem('refreshToken');

  function saveSession({ accessToken, refreshToken, user }, remember) {
    localStorage.setItem('remember', remember ? '1' : '0');
    const s = store();
    s.setItem('accessToken', accessToken);
    if (refreshToken) s.setItem('refreshToken', refreshToken);
    if (user) s.setItem('user', JSON.stringify(user));
  }

  function clearSession() {
    [localStorage, sessionStorage].forEach((s) => {
      s.removeItem('accessToken');
      s.removeItem('refreshToken');
      s.removeItem('user');
    });
  }

  const getUser = () => {
    try { return JSON.parse(store().getItem('user') || 'null'); } catch { return null; }
  };

  let refreshing = null;
  async function tryRefresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const rt = getRefresh();
        if (!rt) return false;
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (!res.ok) return false;
        const json = await res.json();
        store().setItem('accessToken', json.data.accessToken);
        return true;
      })().finally(() => setTimeout(() => { refreshing = null; }, 100));
    }
    return refreshing;
  }

  /**
   * Core request. Throws Error with .message (server message) and .details.
   */
  async function request(method, url, body, isRetry = false) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !isRetry && !url.includes('/auth/')) {
      const ok = await tryRefresh();
      if (ok) return request(method, url, body, true);
      clearSession();
      window.location.href = '/';
      throw new Error('Session expired');
    }

    let json = null;
    try { json = await res.json(); } catch { /* non-JSON (e.g. CSV) */ }
    if (!res.ok) {
      const err = new Error((json && json.message) || `Request failed (${res.status})`);
      err.details = json && json.details;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del: (url) => request('DELETE', url),
    saveSession, clearSession, getUser, getToken, getRefresh,
    logout: async () => {
      try { await request('POST', '/api/auth/logout', { refreshToken: getRefresh() }); } catch { /* ignore */ }
      clearSession();
      window.location.href = '/';
    },
  };
})();
