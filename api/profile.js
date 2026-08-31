// Vercel serverless — derive a client PROFILE from just the domain (server-side OPENAI_API_KEY).
// Fetches the site, then GPT-extracts what they sell + their business category + their ICP.
// POST { domain }  ->  { name, website, services:[...], category, industries:[...], anyBusiness }
module.exports.config = { maxDuration: 60 };

const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\s+/g, '');
function htmlToText(html) { return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
async function getHtml(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(13000) });
    if (r.ok) return await r.text(); } catch (e) {}
  return '';
}
async function fetchSiteText(domain) {
  // find a base that responds: try www then apex, https then http (some sites only serve one)
  let base = '', home = '';
  for (const b of ['https://www.' + domain, 'https://' + domain, 'http://www.' + domain, 'http://' + domain]) {
    home = await getHtml(b); if (home) { base = b.replace(/\/$/, ''); break; }
  }
  if (!base) return '';
  let text = htmlToText(home);
  for (const p of ['services', 'solutions', 'products', 'what-we-do', 'offerings', 'shop', 'about']) {
    if (text.length > 9000) break;
    const h = await getHtml(base + '/' + p); if (h) { const t = htmlToText(h); if (t) text += ' ' + t; }
  }
  return text.slice(0, 9000);
}
async function openai(messages, key, u) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' }, messages }) });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status);
  const jr = await resp.json();
  if (u) { const us = jr.usage || {}; u.pt += us.prompt_tokens || 0; u.ct += us.completion_tokens || 0; }
  try { return JSON.parse(jr.choices[0].message.content); } catch (e) { return {}; }
}
// Fallback when the site blocks Vercel's server IP: Serper's index already has the site's pages, so read the
// client's own pages via `site:domain` (titles + snippets) — fetched from Serper's infra, not ours.
async function serperSiteText(domain) {
  const key = process.env.SERPER_KEY; if (!key) return '';
  try {
    const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'site:' + domain, num: 10 }) });
    if (!r.ok) return '';
    const j = await r.json();
    return (j.organic || []).map(o => ((o.title || '') + ' — ' + (o.snippet || '')).trim()).filter(Boolean).join('\n').slice(0, 8000);
  } catch (e) { return ''; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set in Vercel' })); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const domain = cleanDomain(body && body.domain);
  if (!domain || !domain.includes('.')) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'enter a valid domain' })); }

  const u = { model: 'gpt-4o', pt: 0, ct: 0, serper: 0 };
  try {
    let text = await fetchSiteText(domain), viaSearch = false;
    if (!text || text.length < 60) {                         // direct fetch blocked (datacenter IP) → read the site via Serper's index
      u.serper++; const s = await serperSiteText(domain);
      if (s && s.length >= 60) { text = s; viaSearch = true; }
    }
    if (!text || text.length < 60) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ domain, website: domain, name: domain, services: [], category: '', industries: [], anyBusiness: true, siteUnreachable: true, usage: u }));
    }
    const j = await openai([
      { role: 'system', content: 'From this company website text, extract a structured profile of the business. Return ONLY JSON: {"name":"<company name, short>","category":"<the business category in 2-5 words, distinctive — e.g. \'commercial signage\', \'automotive glass\', \'overseas admissions consulting\'>","services":["<concrete products/services they sell, short noun phrases, most important first, max 20>"],"industries":["<the customer segments / industries they serve (their ICP), short phrases, max 8; [] if they sell to virtually anyone>"]}. Ignore nav/blog/legal boilerplate.' },
      { role: 'user', content: text.slice(0, 9000) }
    ], key, u);
    const services = (Array.isArray(j.services) ? j.services : []).map(s => String(s).trim()).filter(Boolean).slice(0, 20);
    const industries = (Array.isArray(j.industries) ? j.industries : []).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
    res.statusCode = 200;
    res.end(JSON.stringify({ domain, website: domain, name: String(j.name || domain).slice(0, 80), services, category: String(j.category || '').slice(0, 80), industries, anyBusiness: industries.length ? false : true, viaSearch, usage: u }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
};
