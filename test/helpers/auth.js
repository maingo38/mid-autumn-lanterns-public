'use strict';
// Mint a guest session (GUEST_MODE=1) and keep the ml_session cookie so a test
// acts as one consistent user across requests.

async function guest(base, name = 'Tester') {
  const r = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error('guest login failed: ' + r.status);
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/ml_session=([^;]+)/);
  if (!m) throw new Error('no ml_session cookie returned');
  const cookie = 'ml_session=' + m[1];
  const body = await r.json();
  return { cookie, sub: body.user.sub, name: body.user.name };
}

// fetch wrapper that carries a cookie and parses JSON + status together.
function client(base, cookie) {
  return async function call(method, pathname, jsonBody) {
    const headers = { cookie };
    let payload;
    if (jsonBody !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(jsonBody);
    }
    const r = await fetch(base + pathname, { method, headers, body: payload });
    let data = null;
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, data };
  };
}

// Log in as admin (ADMIN_KEY defaults to 'trungthu2026') and return the cookie.
async function admin(base, key = 'trungthu2026') {
  const r = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error('admin login failed: ' + r.status);
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/ml_admin=([^;]+)/);
  if (!m) throw new Error('no ml_admin cookie returned');
  return { cookie: 'ml_admin=' + m[1] };
}

module.exports = { guest, admin, client };
