// redeploy: pick up updated COMPOSIO_API_KEY
// Vercel serverless — feed cannibalisation data source (server-connected: Metabase + GSC).
// Browser calls this in steps to beat the 60s limit; the heavy overlap/winner compute runs client-side.
//   POST { step:"pages", domain }           -> { feedBase, pages:[{kw,vol,status,type,slug,url}] }
//   POST { step:"serp", items:[{kw}], gl }   -> { serp:{ kwLower:[top10 normalized urls] } }
//   POST { step:"gsc", domain }              -> { available, feed:{nurl:{impr,pos}}, nonfeed:[{url,total_impr,top_query,top_query_pos}] }
// Env: METABASE_URL/METABASE_USERNAME/METABASE_PASSWORD/METABASE_DATABASE_ID, SERPER_KEY,
//      GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN (GSC optional — falls back to volume if unset).
module.exports.config = { maxDuration: 60 };

const norm = u => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const normq = q => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ---- Metabase ---- */
async function mbSession() {
  const base = (process.env.METABASE_URL || '').replace(/\/$/, '');
  const r = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.METABASE_USERNAME, password: process.env.METABASE_PASSWORD }) });
  if (!r.ok) throw new Error('Metabase login ' + r.status);
  return (await r.json()).id;
}
async function mbDb(sid) {
  const raw = (process.env.METABASE_DATABASE_ID || '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const base = (process.env.METABASE_URL || '').replace(/\/$/, '');
  const j = await (await fetch(base + '/api/database', { headers: { 'X-Metabase-Session': sid } })).json();
  const list = j.data || j || [];
  const m = list.find(d => (d.name || '').toLowerCase() === raw.toLowerCase());
  return m ? m.id : (list[0] && list[0].id);
}
async function mbSql(sid, db, sql) {
  const base = (process.env.METABASE_URL || '').replace(/\/$/, '');
  const r = await fetch(base + '/api/dataset', { method: 'POST', headers: { 'X-Metabase-Session': sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'native', native: { query: sql }, database: db, constraints: { 'max-results': 100000, 'max-results-bare-rows': 100000 } }) });
  const j = await r.json();
  if (j.status === 'failed' || j.error) throw new Error('MB query: ' + (j.error || '').slice(0, 200));
  return (j.data && j.data.rows) || [];
}
const esc = s => String(s).replace(/'/g, "''");

/* ---- Serper ---- */
async function serper(kw, gl) {
  const key = process.env.SERPER_KEY; if (!key) return [];
  try {
    const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: kw, gl: gl || 'us', num: 10 }) });
    if (!r.ok) return [];
    return ((await r.json()).organic || []).slice(0, 10).map(o => norm(o.link)).filter(Boolean);
  } catch (e) { return []; }
}

/* ---- GSC via Composio (reuses the connected Search Console account) ---- */
// arguments use the Composio tool's snake_case schema (site_url, start_date, ...)
async function gscComposio(args) {
  const key = process.env.COMPOSIO_API_KEY, acct = process.env.COMPOSIO_GSC_ACCOUNT_ID, uid = process.env.COMPOSIO_USER_ID;
  if (!key || (!acct && !uid)) return { rows: [] };
  try {
    const b = { arguments: args };
    if (uid) b.user_id = uid;                              // Composio v3 requires a user/entity id
    if (acct && /^ca_/.test(acct)) b.connected_account_id = acct;  // only if a real id; else auto-resolve by user_id
    const r = await fetch('https://backend.composio.dev/api/v3/tools/execute/GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY', {
      method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(b)
    });
    if (!r.ok) return { rows: [] };
    const j = await r.json();
    const data = (j && j.data) || {};
    const rows = (data.response_data && data.response_data.rows) || data.rows || [];   // Composio nests under data.response_data
    return { rows };
  } catch (e) { return { rows: [] }; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const step = body && body.step;
  const domain = String((body && body.domain) || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  try {
    if (step === 'serp') {
      const items = (body.items || []).slice(0, 30); const gl = (body.gl || 'us').toLowerCase();
      const out = {}; let i = 0;
      const worker = async () => { while (i < items.length) { const it = items[i++]; out[String(it.kw).toLowerCase()] = await serper(it.kw, gl); } };
      await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
      res.statusCode = 200; return res.end(JSON.stringify({ serp: out }));
    }
    if (step === 'pages') {
      if (!process.env.METABASE_URL) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'Metabase env not set on the server' })); }
      const sid = await mbSession(); const db = await mbDb(sid);
      const rows = await mbSql(sid, db, `SELECT c.primary_kw,c.volume,c.page_status,c.page_type,c.slug,p.canonical_url FROM public.clusters c JOIN public.projects p ON p.id=c.p_id WHERE LOWER(p.root_domain)='${esc(domain)}' AND c.d_at IS NULL AND c.primary_kw IS NOT NULL ORDER BY c.volume DESC NULLS LAST`);
      const base = ((rows[0] && rows[0][5]) || ('https://' + domain + '/feeds')).replace(/\/+$/, '');
      const byKw = {};
      rows.forEach(r => { const k = String(r[0]).trim().toLowerCase(); const url = base + '/' + String(r[3] || 'service').toLowerCase() + '/' + (r[4] || ''); const p = { kw: String(r[0]).trim(), vol: r[1] || 0, status: r[2] || 'null', type: r[3] || '', slug: r[4] || '', url }; if (!byKw[k] || p.vol > byKw[k].vol) byKw[k] = p; });
      res.statusCode = 200; return res.end(JSON.stringify({ feedBase: base, pages: Object.values(byKw) }));
    }
    if (step === 'gsc') {
      if (!process.env.COMPOSIO_API_KEY || (!process.env.COMPOSIO_GSC_ACCOUNT_ID && !process.env.COMPOSIO_USER_ID)) { res.statusCode = 200; return res.end(JSON.stringify({ available: false })); }
      const site = 'sc-domain:' + domain;
      const now = new Date(Date.now() - 3 * 864e5), start = new Date(Date.now() - 480 * 864e5);
      const dt = d => d.toISOString().slice(0, 10);
      const feedR = await gscComposio({ site_url: site, start_date: dt(start), end_date: dt(now), dimensions: ['page'], row_limit: 25000, data_state: 'final', dimension_filter_groups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/feeds/' }] }] });
      const nfR = await gscComposio({ site_url: site, start_date: dt(start), end_date: dt(now), dimensions: ['page', 'query'], row_limit: 25000, data_state: 'final', dimension_filter_groups: [{ filters: [{ dimension: 'page', operator: 'notContains', expression: '/feeds/' }] }] });
      if (!feedR.rows.length && !nfR.rows.length) { res.statusCode = 200; return res.end(JSON.stringify({ available: false, note: 'Composio returned no GSC rows — check COMPOSIO_GSC_ACCOUNT_ID has access to ' + site })); }
      const feed = {};
      (feedR.rows || []).forEach(r => { feed[norm(r.keys[0])] = { impr: r.impressions, pos: Math.round(r.position * 10) / 10 }; });
      const BRAND = new RegExp(domain.replace(/\..*/, '') + '|site:', 'i');
      const tot = {}, best = {};
      (nfR.rows || []).forEach(r => { const pg = norm(r.keys[0]), q = r.keys[1]; tot[pg] = (tot[pg] || 0) + r.impressions; if (BRAND.test(q) || /^[\d\W]+$/.test(q)) return; const b = best[pg]; if (!b || r.impressions > b.impr) best[pg] = { query: q, impr: r.impressions, pos: Math.round(r.position * 10) / 10 }; });
      const nonfeed = Object.keys(tot).map(pg => ({ url: pg, total_impr: tot[pg], top_query: best[pg] ? best[pg].query : '', top_query_pos: best[pg] ? best[pg].pos : null })).sort((a, b) => b.total_impr - a.total_impr);
      res.statusCode = 200; return res.end(JSON.stringify({ available: true, feed, nonfeed }));
    }
    if (step === 'listconn') {
      const key = process.env.COMPOSIO_API_KEY; if (!key) { res.statusCode = 200; return res.end(JSON.stringify({ hasKey: false })); }
      const envAcct = process.env.COMPOSIO_GSC_ACCOUNT_ID || '(unset)', envUser = process.env.COMPOSIO_USER_ID || '(unset)';
      const r = await fetch('https://backend.composio.dev/api/v3/connected_accounts?toolkit_slugs=google_search_console', { headers: { 'x-api-key': key } });
      const txt = await r.text(); let list = [];
      try { const o = JSON.parse(txt); const items = o.items || o.data || (Array.isArray(o) ? o : []); list = items.map(a => ({ id: a.id, user_id: a.user_id || a.entity_id || (a.entity && a.entity.id), status: a.status, toolkit: (a.toolkit && (a.toolkit.slug || a.toolkit)) || a.app_name })); } catch (e) {}
      // verify: run a tiny GSC query against the first ACTIVE connection
      let verify = null; const act = list.find(a => a.status === 'ACTIVE');
      if (act) {
        const er = await fetch('https://backend.composio.dev/api/v3/tools/execute/GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ connected_account_id: act.id, user_id: act.user_id || 'default', arguments: { site_url: 'sc-domain:' + (domain || 'protectt.ai'), start_date: '2026-06-01', end_date: '2026-08-05', dimensions: ['page'], row_limit: 3 } })
        });
        const et = await er.text(); let rows = null; try { const ej = JSON.parse(et); rows = (ej.data && ej.data.rows) ? ej.data.rows.length : null; } catch (e) {}
        verify = { usedId: act.id, usedUser: act.user_id || 'default', status: er.status, rows, body: rows == null ? et.slice(0, 400) : undefined };
      }
      res.statusCode = 200; return res.end(JSON.stringify({ httpStatus: r.status, count: list.length, connections: list, verify, envAcct, envUser }));
    }
    if (step === 'gscdebug') {
      const key = process.env.COMPOSIO_API_KEY, acct = process.env.COMPOSIO_GSC_ACCOUNT_ID;
      if (!key || !acct) { res.statusCode = 200; return res.end(JSON.stringify({ hasKey: !!key, hasAcct: !!acct })); }
      // fetch the connected account to discover its entity/user id
      const ca = await fetch('https://backend.composio.dev/api/v3/connected_accounts/' + encodeURIComponent(acct), { headers: { 'x-api-key': key } });
      const caj = await ca.text();
      let uid = ''; try { const o = JSON.parse(caj); uid = o.user_id || o.entity_id || (o.data && (o.data.user_id || o.data.entity_id)) || ''; } catch (e) {}
      const attempt = async (uidVal) => {
        const r = await fetch('https://backend.composio.dev/api/v3/tools/execute/GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ connected_account_id: acct, user_id: uidVal, arguments: { site_url: 'sc-domain:' + domain, start_date: '2026-06-01', end_date: '2026-08-05', dimensions: ['page'], row_limit: 3 } })
        });
        return { uid: uidVal, status: r.status, body: (await r.text()).slice(0, 500) };
      };
      const tries = [];
      for (const u of [uid, 'default'].filter((v, i, a) => v !== undefined && a.indexOf(v) === i)) tries.push(await attempt(u));
      res.statusCode = 200; return res.end(JSON.stringify({ caStatus: ca.status, discoveredUid: uid, ca: caj.slice(0, 300), tries }));
    }
    res.statusCode = 400; res.end(JSON.stringify({ error: 'unknown step' }));
  } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
};
