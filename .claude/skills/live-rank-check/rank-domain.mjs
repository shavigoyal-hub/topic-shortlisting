#!/usr/bin/env node
/* Domain-level LIVE rank (Serper).
 * For each query, return the domain's best live Google position (top-100) and the exact ranking URL.
 *
 * Usage:
 *   node rank-domain.mjs --domain qrstuff.com "twitter qr code generator" "coupon qr code" [--country us]
 *   node rank-domain.mjs --domain site.com --file keywords.csv [--country in] [--json]
 *   printf "%s\n" "kw one" "kw two" | node rank-domain.mjs --domain site.com
 *
 * Serper key: --key <k>, or SERPER_KEY env, or a SERPER_KEY= line in ./bulk/.env or ./.env.
 */
import fs from 'node:fs';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const country = arg('country', 'us');
const num = Number(arg('num', 100));
const domain = (arg('domain') || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
if (!domain) { console.error('Pass --domain <domain>'); process.exit(1); }

let key = arg('key', process.env.SERPER_KEY || '');
if (!key) { for (const p of ['./bulk/.env', './.env', new URL('./.env', import.meta.url).pathname]) { try { const m = fs.readFileSync(p, 'utf8').match(/SERPER_KEY\s*=\s*["']?([^"'\n]+)/); if (m) { key = m[1].trim(); break; } } catch (e) {} } }
if (!key) { console.error('No Serper key. Pass --key <k>, set SERPER_KEY, or add SERPER_KEY= to bulk/.env'); process.exit(1); }

const norm = u => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const parseCsv = l => { const out = []; let cur = '', q = false; for (const c of l) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(x => x.replace(/^"|"$/g, '').trim()); };

// gather queries: --file (query/keyword column, else every line) OR positional args OR stdin
let qs = [];
const file = arg('file');
if (file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const head = parseCsv(lines[0]).map(h => h.toLowerCase());
  const qi = head.findIndex(h => /\b(query|keyword)\b/.test(h));
  if (qi >= 0) { for (let i = 1; i < lines.length; i++) { const q = parseCsv(lines[i])[qi]; if (q) qs.push(q); } }
  else qs = lines;
}
if (!qs.length) { const FV = new Set(['country', 'num', 'domain', 'key', 'file']); for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('--')) { if (FV.has(a.slice(2))) i++; continue; } qs.push(a); } }
if (!qs.length && !process.stdin.isTTY) { qs = fs.readFileSync(0, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
qs = [...new Set(qs.filter(Boolean))];
if (!qs.length) { console.error('No queries. Pass them inline, via --file <csv>, or on stdin.'); process.exit(1); }

async function serp(q) { for (let a = 0; a < 3; a++) { try { const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: country, num }), signal: AbortSignal.timeout(20000) }); if (!r.ok) { await new Promise(s => setTimeout(s, 1000)); continue; } return ((await r.json()).organic || []).map(o => o.link); } catch (e) { await new Promise(s => setTimeout(s, 800)); } } return []; }
async function mapLimit(items, limit, fn) { let i = 0; const out = new Array(items.length); async function w() { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); return out; }

(async () => {
  process.stderr.write(`${domain} — ${qs.length} queries (gl=${country}, top-${num})…\n`);
  const res = await mapLimit(qs, 5, async q => {
    const links = await serp(q);
    let pos = null, url = null;
    for (let i = 0; i < links.length; i++) { const n = norm(links[i]); if (n === domain || n.startsWith(domain + '/') || n.endsWith('.' + domain) || n.includes('.' + domain + '/')) { pos = i + 1; url = links[i]; break; } }
    return { query: q, position: pos, url };
  });
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  for (const r of res) console.log((r.position ? ('#' + r.position).padEnd(6) : 'none'.padEnd(6)) + '  ' + r.query.slice(0, 44).padEnd(44) + '  ' + (r.url ? r.url.replace(/^https?:\/\//, '') : '—'));
  const rk = res.filter(r => r.position), p1 = res.filter(r => r.position && r.position <= 10);
  console.log(`\n${res.length} queries · ${p1.length} on page 1 (top 10) · ${rk.length} in top-${num} · ${res.length - rk.length} not ranking`);
})();
