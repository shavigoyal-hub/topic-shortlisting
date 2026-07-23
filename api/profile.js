// Vercel serverless — derive a client PROFILE from just the domain (server-side OPENAI_API_KEY).
// Fetches the site, then GPT-extracts what they sell + their business category + their ICP.
// POST { domain }  ->  { name, website, services:[...], category, industries:[...], anyBusiness }
module.exports.config = { maxDuration: 60 };

const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\s+/g, '');
function htmlToText(html) { return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }
async function fetchSiteText(domain) {
  const paths = ['', 'services', 'solutions', 'products', 'what-we-do', 'offerings', 'about'];
  let text = '';
  for (const p of paths) { if (text.length > 9000) break;
    try {
      const r = await fetch('https://' + domain + '/' + p, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AkrEnrich/1.0)' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      if (r.ok) { const t = htmlToText(await r.text()); if (t) text += ' ' + t; }
    } catch (e) {}
  }
  return text.slice(0, 9000);
}
async function openai(messages, key) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' }, messages }) });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status);
  try { return JSON.parse((await resp.json()).choices[0].message.content); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set in Vercel' })); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const domain = cleanDomain(body && body.domain);
  if (!domain || !domain.includes('.')) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'enter a valid domain' })); }

  try {
    const text = await fetchSiteText(domain);
    if (!text || text.length < 60) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ domain, website: domain, name: domain, services: [], category: '', industries: [], anyBusiness: true, siteUnreachable: true }));
    }
    const j = await openai([
      { role: 'system', content: 'From this company website text, extract a structured profile of the business. Return ONLY JSON: {"name":"<company name, short>","category":"<the business category in 2-5 words, distinctive — e.g. \'commercial signage\', \'automotive glass\', \'overseas admissions consulting\'>","services":["<concrete products/services they sell, short noun phrases, most important first, max 20>"],"industries":["<the customer segments / industries they serve (their ICP), short phrases, max 8; [] if they sell to virtually anyone>"]}. Ignore nav/blog/legal boilerplate.' },
      { role: 'user', content: text.slice(0, 9000) }
    ], key);
    const services = (Array.isArray(j.services) ? j.services : []).map(s => String(s).trim()).filter(Boolean).slice(0, 20);
    const industries = (Array.isArray(j.industries) ? j.industries : []).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
    res.statusCode = 200;
    res.end(JSON.stringify({ domain, website: domain, name: String(j.name || domain).slice(0, 80), services, category: String(j.category || '').slice(0, 80), industries, anyBusiness: industries.length ? false : true }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
};
