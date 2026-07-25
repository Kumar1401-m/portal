/**
 * Reset-password page logic (external file — the CSP blocks inline scripts).
 */
'use strict';

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.style.display = 'none';
  const p1 = document.getElementById('password').value;
  const p2 = document.getElementById('confirm').value;
  if (p1 !== p2) {
    err.textContent = 'Passwords do not match';
    err.style.display = 'block';
    return;
  }
  const token = new URLSearchParams(window.location.search).get('token');
  try {
    const res = await Api.post('/api/auth/reset-password', { token, password: p1 });
    alert(res.message);
    window.location.href = '/';
  } catch (ex) {
    err.textContent = ex.message + (ex.details ? ' — ' + ex.details.map((d) => d.message).join(', ') : '');
    err.style.display = 'block';
  }
});
