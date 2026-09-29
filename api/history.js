// Per-user run history, persisted in Vercel KV (Upstash Redis REST). Every entry is stamped with the
// signed-in user's email server-side (clients cannot spoof identity).
//   GET  /api/history            -> { user, entries:[...] }  (this user's runs, newest first)
//   GET  /api/history?all=1       -> admins only: everyone's runs merged, newest first
//   POST /api/history {entry}     -> append one run for this user
//   POST /api/history {clear:true}-> delete this user's history
const { requireUser, isAdmin } = require('../lib/session');

async function kv(cmd) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error('KV not configured (create a Vercel KV store)');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const user = requireUser(req, res); if (!user) return;
  const email = String(user.email).toLowerCase();
  const key = 'hist:' + email;

  try {
    if (req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      if (body && body.clear) { await kv(['DEL', key]); return res.end(JSON.stringify({ ok: true, cleared: true })); }
      const src = (body && body.entry) || body || {};
      const entry = Object.assign({}, src, {
        userEmail: email,
        userName: user.name || email,
        when: new Date().toISOString(),
        id: src.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 8))
      });
      delete entry.csv; // keep KV small; CSVs stay cached in the browser that produced them
      await kv(['LPUSH', key, JSON.stringify(entry)]);
      await kv(['LTRIM', key, '0', '499']);
      await kv(['SADD', 'hist:users', email]);
      return res.end(JSON.stringify({ ok: true, entry }));
    }

    // GET
    const wantAll = /(?:^|[?&])all=1(?:&|$)/.test(req.url || '') && isAdmin(user);
    if (wantAll) {
      const users = (await kv(['SMEMBERS', 'hist:users'])) || [];
      let all = [];
      for (const u of users) {
        const rows = (await kv(['LRANGE', 'hist:' + u, '0', '199'])) || [];
        all = all.concat(rows.map(parse).filter(Boolean));
      }
      all.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
      return res.end(JSON.stringify({ user: { email, name: user.name, admin: true }, all: true, entries: all }));
    }
    const rows = (await kv(['LRANGE', key, '0', '199'])) || [];
    return res.end(JSON.stringify({ user: { email, name: user.name, admin: isAdmin(user) }, entries: rows.map(parse).filter(Boolean) }));
  } catch (e) {
    res.statusCode = 500; return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
