/**
 * Login page logic (external file — the CSP blocks inline scripts).
 */
'use strict';

(function () {
  // Already signed in? Route straight to the right shell.
  const u = Api.getUser();
  if (u && Api.getToken()) {
    window.location.href = u.role === 'client' ? '/portal' : '/admin';
    return;
  }

  const err = document.getElementById('err');
  const btn = document.getElementById('loginBtn');

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const remember = document.getElementById('remember').checked;
      const res = await Api.post('/api/auth/login', {
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
        remember,
      });
      Api.saveSession(res.data, remember);
      window.location.href = res.data.user.role === 'client' ? '/portal' : '/admin';
    } catch (ex) {
      err.textContent = ex.message || 'Login failed';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  document.getElementById('forgotLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    if (!email) {
      err.textContent = 'Enter your email above first, then click "Forgot password?"';
      err.style.display = 'block';
      return;
    }
    try {
      const res = await Api.post('/api/auth/forgot-password', { email });
      err.style.display = 'block';
      err.style.background = 'var(--green-bg)';
      err.style.color = 'var(--green)';
      err.textContent = res.message;
    } catch (ex) {
      err.style.display = 'block';
      err.textContent = ex.message;
    }
  });
})();
