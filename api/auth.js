// Google Sign-In, restricted to @gushwork.ai.
//   GET  /api/auth            -> { email, name, admin } if a valid session cookie exists, else {}
//   POST /api/auth {credential}-> verify the Google ID token, enforce gushwork.ai, set session cookie
//   POST /api/auth {logout:true}-> clear the session cookie
const { sign, getUser, isAdmin, cookieHeader, clearCookieHeader } = require('../lib/session');
const ALLOWED_DOMAIN = 'gushwork.ai';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    const u = getUser(req);
    return res.end(JSON.stringify(u ? { email: u.email, name: u.name, admin: isAdmin(u) } : {}));
  }

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  if (body && body.logout) {
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.end(JSON.stringify({ ok: true }));
  }

  const cred = body && body.credential;
  if (!cred) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing credential' })); }
  if (!process.env.SESSION_SECRET) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'SESSION_SECRET not set on server' })); }

  try {
    // Google verifies signature + expiry for us; we then enforce audience, verified email, and the gushwork.ai domain.
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
    if (!r.ok) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid Google token' })); }
    const t = await r.json();

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && t.aud !== clientId) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'token audience mismatch' })); }

    const email = String(t.email || '').toLowerCase();
    const verified = t.email_verified === true || t.email_verified === 'true';
    const domain = String(t.hd || (email.split('@')[1] || '')).toLowerCase();
    if (!verified) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'email not verified' })); }
    if (domain !== ALLOWED_DOMAIN) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Only @gushwork.ai Google accounts can sign in' })); }

    const token = sign({ email, name: t.name || email, sub: t.sub || '' });
    res.setHeader('Set-Cookie', cookieHeader(token));
    return res.end(JSON.stringify({ email, name: t.name || email, admin: isAdmin({ email }) }));
  } catch (e) {
    res.statusCode = 502; return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
