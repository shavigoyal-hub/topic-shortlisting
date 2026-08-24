#!/usr/bin/env node
/* Page-level LIVE rank check (Serper).
 * For each (query, url[, url2, ...]) row, report the EXACT page's live Google position (top-100),
 * and — for pairs — whether BOTH pages co-rank (the live confirmation of active cannibalization).
 *
 * Usage:
 *   node rank-pages.mjs --file report.csv [--country us] [--num 100] [--json]
 *   node rank-pages.mjs --query "intranet software" --url https://site.com/a --url https://site.com/b
 *
 * CSV: auto-detects a query/keyword column + one or more url columns
 *      (url / page / "primary url" / "cannibalising url" all work — e.g. our cannibalization reports).
 * Serper key: --key <k>, or SERPER_KEY env, or a SERPER_KEY= line in ./bulk/.env or ./.env.
 */
import fs from 'node:fs';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const country = arg('country', 'us');
const num = Number(arg('num', 100));

let key = arg('key', process.env.SERPER_KEY || '');
if (!key) { for (const p of ['./bulk/.env', './.env', new URL('./.env', import.meta.url).pathname]) { try { const m = fs.readFileSync(p, 'utf8').match(/SERPER_KEY\s*=\s*["']?([^"'\n]+)/); if (m) { key = m[1].trim(); break; } } catch (e) {} } }
if (!key) { console.error('No Serper key. Pass --key <k>, set SERPER_KEY, or add SERPER_KEY= to bulk/.env'); process.exit(1); }

const norm = u => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const parseCsv = l => { const out = []; let cur = '', q = false; for (const c of l) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(x => x.replace(/^"|"$/g, '').trim()); };

let rows = [];
const file = arg('file');
if (file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const head = parseCsv(lines[0]).map(h => h.toLowerCase());
  const qi = head.findIndex(h => /\b(query|keyword|deciding query|shared query)\b/.test(h) || h === 'query');
  const ui = head.map((h, i) => (/url|page|primary|cannibal/.test(h)) ? i : -1).filter(i => i >= 0);
  if (qi >= 0 && ui.length) {
    for (let i = 1; i < lines.length; i++) { const c = parseCsv(lines[i]); const query = c[qi]; const urls = ui.map(x => c[x]).filter(u => /^https?:\/\//i.test(u)); if (query && urls.length) rows.push({ query, urls }); }
  } else { // fallback: each line is "query,url[,url...]"
    for (const l of lines) { const c = parseCsv(l); if (c.length >= 2 && /^https?/i.test(c[1])) rows.push({ query: c[0], urls: c.slice(1).filter(u => /^https?/i.test(u)) }); }
  }
}
if (!rows.length) { const q = arg('query'); const urls = args.filter((a, i) => args[i - 1] === '--url'); if (q && urls.length) rows = [{ query: q, urls }]; }
if (!rows.length) { console.error('No (query,url) rows. Use --file <csv> (query + url columns), or --query "q" --url <u> [--url <u2>]'); process.exit(1); }

const uniq = [...new Set(rows.map(r => r.query))];
const cache = {};
async function serp(q) { for (let a = 0; a < 3; a++) { try { const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: country, num }), signal: AbortSignal.timeout(20000) }); if (!r.ok) { await new Promise(s => setTimeout(s, 1000)); continue; } return ((await r.json()).organic || []).map(o => norm(o.link)); } catch (e) { await new Promise(s => setTimeout(s, 800)); } } return []; }
async function mapLimit(items, limit, fn) { let i = 0; async function w() { while (i < items.length) { const k = i++; await fn(items[k]); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); }
const posOf = (lt, u) => { const n = norm(u); const i = lt.findIndex(x => x === n || x.split('?')[0] === n); return i < 0 ? null : i + 1; };

(async () => {
  process.stderr.write(`Checking ${uniq.length} unique queries (gl=${country}, top-${num})…\n`);
  await mapLimit(uniq, 5, async q => { cache[q] = await serp(q); });
  const out = rows.map(r => ({ query: r.query, positions: (cache[r.query] || []).length ? r.urls.map(u => ({ url: u, pos: posOf(cache[r.query], u) })) : r.urls.map(u => ({ url: u, pos: null })) }));
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  let anyRank = 0, none = 0, coRank = 0, pairs = 0;
  for (const r of out) {
    const ranked = r.positions.filter(p => p.pos).length;
    if (ranked >= 1) anyRank++; else none++;
    if (r.positions.length >= 2) { pairs++; if (ranked >= 2) coRank++; }
    console.log(r.query.slice(0, 42).padEnd(42) + '  ' + r.positions.map(p => (p.pos ? '#' + p.pos : 'not ranking') + '  ' + p.url.replace(/^https?:\/\//, '').replace(/^www\./, '').slice(0, 52)).join('   |   '));
  }
  console.log('\n' + out.length + ' rows · ' + anyRank + ' with ≥1 page ranking live · ' + none + ' none ranking'
    + (pairs ? ('\nOf ' + pairs + ' pairs: ' + coRank + ' have BOTH pages ranking live (confirmed active cannibalization), ' + (pairs - coRank) + ' do not (stale / one-sided).') : ''));
})();
