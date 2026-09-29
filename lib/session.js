// Shared auth/session helper (CommonJS, no deps). Signs a short HMAC-JWT session cookie after a
// verified @gushwork.ai Google sign-in, and reads it back on every protected endpoint.
const crypto = require('crypto');
const SECRET = process.env.SESSION_SECRET || '';
const COOKIE = 'gw_session';
const TTL = 7 * 24 * 3600; // 7 days
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(); }

function sign(payload) {
  if (!SECRET) throw new Error('SESSION_SECRET not set');
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now, exp: now + TTL }, payload);
  const data = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
  return data + '.' + sig;
}

function verify(token) {
  try {
    if (!token || !SECRET) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const data = parts[0] + '.' + parts[1];
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
    const a = Buffer.from(parts[2]); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(unb64url(parts[1]));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch (e) { return null; }
}

function readCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// Returns the signed-in user {email,name,sub} or null. Accepts the session cookie or a Bearer token.
function getUser(req) {
  let t = '';
  const a = req.headers.authorization || '';
  if (a.startsWith('Bearer ')) t = a.slice(7);
  if (!t) t = readCookie(req, COOKIE);
  return verify(t);
}

function isAdmin(user) { return !!user && ADMIN_EMAILS.includes(String(user.email || '').toLowerCase()); }

function cookieHeader(token) { return COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + TTL; }
function clearCookieHeader() { return COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'; }

// Guard for protected endpoints: writes a 401 and returns null if not signed in; else returns the user.
function requireUser(req, res) {
  const u = getUser(req);
  if (!u) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Sign in with your @gushwork.ai Google account' }));
    return null;
  }
  return u;
}

module.exports = { sign, verify, getUser, isAdmin, requireUser, cookieHeader, clearCookieHeader, COOKIE };
